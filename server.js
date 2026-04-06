import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

// Try to load StreamableHTTP (available in newer SDK versions)
let StreamableHTTPServerTransport;
try {
  const mod = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  StreamableHTTPServerTransport = mod.StreamableHTTPServerTransport;
  console.log("[INIT] StreamableHTTP transport available");
} catch {
  console.log("[INIT] StreamableHTTP not available, using SSE only");
}

const PORT = process.env.PORT || 3001;

// ============ SESSION STORE ============
const sessions = {};
const transports = {};

function getSession(id) {
  if (!sessions[id]) sessions[id] = { connected: false };
  return sessions[id];
}

// ============ TOKEN MANAGEMENT ============
async function getToken(sess) {
  if (!sess.connected) throw new Error("No conectado. Usa bc_connect primero.");
  if (sess.token && Date.now() < sess.tokenExpiry) return sess.token;
  console.log(`[AUTH] Token for tenant ${sess.tenant.substring(0, 8)}...`);
  const r = await fetch(`https://login.microsoftonline.com/${sess.tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: sess.clientId,
      client_secret: sess.clientSecret,
      scope: sess.scope || "https://api.businesscentral.dynamics.com/.default",
    }),
  });
  if (!r.ok) throw new Error(`Auth error ${r.status}: ${await r.text()}`);
  const d = await r.json();
  sess.token = d.access_token;
  sess.tokenExpiry = Date.now() + (d.expires_in - 120) * 1000;
  return sess.token;
}

function apiBase(sess) {
  return `https://api.businesscentral.dynamics.com/v2.0/${sess.tenant}/${sess.environment}/api/v2.0`;
}

// ============ BC API HELPERS ============
async function bcGet(sess, endpoint, params = {}) {
  const tk = await getToken(sess);
  const qp = [];
  if (params.top) qp.push(`$top=${params.top}`);
  if (params.filter) qp.push(`$filter=${encodeURIComponent(params.filter)}`);
  if (params.select) qp.push(`$select=${params.select}`);
  if (params.orderby) qp.push(`$orderby=${encodeURIComponent(params.orderby)}`);
  const qs = qp.length ? `?${qp.join("&")}` : "";
  const url = `${apiBase(sess)}/${endpoint}${qs}`;
  console.log(`[BC] GET ${url}`);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`BC ${r.status}: ${(await r.text()).substring(0, 500)}`);
  const d = await r.json();
  return d.value || d;
}

async function bcPost(sess, endpoint, payload) {
  const tk = await getToken(sess);
  const url = `${apiBase(sess)}/${endpoint}`;
  console.log(`[BC] POST ${url}`);
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`BC POST ${r.status}: ${(await r.text()).substring(0, 500)}`);
  return r.json();
}

async function bcPatch(sess, endpoint, payload, etag) {
  const tk = await getToken(sess);
  const url = `${apiBase(sess)}/${endpoint}`;
  console.log(`[BC] PATCH ${url}`);
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json", Accept: "application/json", "If-Match": etag },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`BC PATCH ${r.status}: ${(await r.text()).substring(0, 500)}`);
  return r.json();
}

// ============ REGISTER TOOLS ============
function registerTools(server, sessionId) {
  server.tool("bc_connect", "Conecta con un tenant de Business Central.", {
    tenant: z.string().describe("Tenant ID (GUID)"),
    environment: z.string().describe("Entorno: Production, Sandbox"),
    clientId: z.string().describe("Client ID de Azure AD"),
    clientSecret: z.string().describe("Client Secret"),
    scope: z.string().optional().default("https://api.businesscentral.dynamics.com/.default"),
  }, async ({ tenant, environment, clientId, clientSecret, scope }) => {
    const sess = getSession(sessionId);
    Object.assign(sess, { tenant, environment, clientId, clientSecret, scope, token: null, tokenExpiry: 0 });
    try {
      await getToken(sess);
      sess.connected = true;
      return { content: [{ type: "text", text: `Conectado a BC!\nTenant: ${tenant}\nEntorno: ${environment}\nToken OK` }] };
    } catch (e) {
      sess.connected = false;
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  });

  server.tool("bc_list_companies", "Lista empresas disponibles", {}, async () => {
    const data = await bcGet(getSession(sessionId), "companies");
    return { content: [{ type: "text", text: JSON.stringify(data.map(c => ({ id: c.id, name: c.name, displayName: c.displayName })), null, 2) }] };
  });

  server.tool("bc_query", "Consulta cualquier entidad de BC", {
    companyId: z.string().describe("ID empresa (GUID)"),
    entity: z.string().describe("customers, vendors, items, salesOrders, salesInvoices, etc."),
    top: z.number().optional().default(20),
    filter: z.string().optional().describe("Filtro OData"),
    select: z.string().optional().describe("Campos"),
    orderby: z.string().optional().describe("Orden"),
  }, async ({ companyId, entity, top, filter, select, orderby }) => {
    const data = await bcGet(getSession(sessionId), `companies(${companyId})/${entity}`, { top, filter, select, orderby });
    return { content: [{ type: "text", text: `${entity}: ${data.length} registros\n\n${JSON.stringify(data, null, 2)}` }] };
  });

  server.tool("bc_customer_summary", "Resumen financiero de un cliente", {
    companyId: z.string(),
    customerNumber: z.string(),
  }, async ({ companyId, customerNumber }) => {
    const sess = getSession(sessionId);
    const b = `companies(${companyId})`;
    const cust = await bcGet(sess, `${b}/customers`, { filter: `number eq '${customerNumber}'` });
    if (!cust.length) return { content: [{ type: "text", text: `Cliente ${customerNumber} no encontrado` }] };
    const inv = await bcGet(sess, `${b}/salesInvoices`, { filter: `customerNumber eq '${customerNumber}'`, top: 10, orderby: "invoiceDate desc" });
    const aged = await bcGet(sess, `${b}/agedAccountsReceivables`, { filter: `customerNumber eq '${customerNumber}'` });
    return { content: [{ type: "text", text: JSON.stringify({ customer: cust[0], recentInvoices: inv, aging: aged }, null, 2) }] };
  });

  server.tool("bc_inventory", "Estado del inventario", {
    companyId: z.string(),
    lowStockThreshold: z.number().optional().default(10),
  }, async ({ companyId, lowStockThreshold }) => {
    const items = await bcGet(getSession(sessionId), `companies(${companyId})/items`, { top: 100, select: "displayName,number,inventory,unitPrice,unitCost,itemCategoryCode" });
    const low = items.filter(i => i.inventory <= lowStockThreshold && i.inventory >= 0);
    const totalVal = items.reduce((s, i) => s + (i.inventory || 0) * (i.unitCost || 0), 0);
    return { content: [{ type: "text", text: JSON.stringify({ totalItems: items.length, totalValue: totalVal, lowStock: low, topByValue: items.map(i => ({ ...i, value: (i.inventory || 0) * (i.unitCost || 0) })).sort((a, b) => b.value - a.value).slice(0, 10) }, null, 2) }] };
  });

  server.tool("bc_sales_summary", "Resumen de ventas", {
    companyId: z.string(),
    top: z.number().optional().default(20),
  }, async ({ companyId, top }) => {
    const inv = await bcGet(getSession(sessionId), `companies(${companyId})/salesInvoices`, { top, orderby: "invoiceDate desc", select: "number,invoiceDate,customerName,totalAmountIncludingTax,status,remainingAmount" });
    const total = inv.reduce((s, i) => s + (i.totalAmountIncludingTax || 0), 0);
    const pending = inv.reduce((s, i) => s + (i.remainingAmount || 0), 0);
    const byCust = {};
    inv.forEach(i => { if (!byCust[i.customerName]) byCust[i.customerName] = { total: 0, count: 0 }; byCust[i.customerName].total += i.totalAmountIncludingTax || 0; byCust[i.customerName].count++; });
    return { content: [{ type: "text", text: JSON.stringify({ invoiceCount: inv.length, totalSales: total, totalPending: pending, topCustomers: Object.entries(byCust).map(([n, d]) => ({ name: n, ...d })).sort((a, b) => b.total - a.total).slice(0, 10), recent: inv.slice(0, 5) }, null, 2) }] };
  });

  server.tool("bc_create", "Crear registro en BC", {
    companyId: z.string(),
    entity: z.string(),
    data: z.string().describe("JSON con los datos"),
  }, async ({ companyId, entity, data }) => {
    const result = await bcPost(getSession(sessionId), `companies(${companyId})/${entity}`, JSON.parse(data));
    return { content: [{ type: "text", text: `Creado OK:\n${JSON.stringify(result, null, 2)}` }] };
  });

  server.tool("bc_update", "Actualizar registro en BC", {
    companyId: z.string(),
    entity: z.string(),
    entityId: z.string(),
    etag: z.string(),
    data: z.string(),
  }, async ({ companyId, entity, entityId, etag, data }) => {
    const result = await bcPatch(getSession(sessionId), `companies(${companyId})/${entity}(${entityId})`, JSON.parse(data), etag);
    return { content: [{ type: "text", text: `Actualizado OK:\n${JSON.stringify(result, null, 2)}` }] };
  });

  server.tool("bc_custom", "Consulta APIs personalizadas", {
    url: z.string(),
    top: z.number().optional().default(20),
    filter: z.string().optional(),
  }, async ({ url, top, filter }) => {
    const sess = getSession(sessionId);
    const full = url.startsWith("http") ? url : `${apiBase(sess)}/${url}`;
    const qp = [];
    if (top) qp.push(`$top=${top}`);
    if (filter) qp.push(`$filter=${encodeURIComponent(filter)}`);
    const qs = qp.length ? `?${qp.join("&")}` : "";
    const tk = await getToken(sess);
    const r = await fetch(`${full}${qs}`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } });
    if (!r.ok) throw new Error(`BC ${r.status}: ${(await r.text()).substring(0, 500)}`);
    const d = await r.json();
    const records = d.value || d;
    return { content: [{ type: "text", text: `${Array.isArray(records) ? records.length : 1} registros:\n${JSON.stringify(records, null, 2)}` }] };
  });

  server.tool("bc_status", "Estado de la conexion", {}, async () => {
    const sess = getSession(sessionId);
    if (!sess.connected) return { content: [{ type: "text", text: "No conectado." }] };
    return { content: [{ type: "text", text: `Conectado:\n  Tenant: ${sess.tenant}\n  Entorno: ${sess.environment}\n  Token: ${sess.token ? "Activo" : "Expirado"}` }] };
  });
}

// ============ CREATE SERVER FOR A CONNECTION ============
function createServerForSession(sessionId) {
  const mcpServer = new McpServer({ name: "business-central", version: "2.0.0" });
  registerTools(mcpServer, sessionId);
  return mcpServer;
}

// ============ EXPRESS ============
const app = express();

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, Cache-Control");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use(express.json());

// ---- STREAMABLE HTTP (POST /sse) ----
app.post("/sse", async (req, res) => {
  if (!StreamableHTTPServerTransport) {
    return res.status(404).json({ error: "Streamable HTTP not supported" });
  }

  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && transports[sessionId]) {
    console.log(`[MCP] Streamable message for session: ${sessionId}`);
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (e) {
      console.error(`[MCP] Error:`, e);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
    return;
  }

  // New streamable session
  console.log("[MCP] New Streamable HTTP session");
  const sid = `sh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const mcpServer = createServerForSession(sid);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sid });
  transports[sid] = transport;

  transport.onclose = () => {
    console.log(`[MCP] Streamable session closed: ${sid}`);
    delete transports[sid];
    delete sessions[sid];
  };

  await mcpServer.connect(transport);
  console.log(`[MCP] Streamable session created: ${sid}`);
  await transport.handleRequest(req, res);
});

// ---- SSE LEGACY (GET /sse) ----
app.get("/sse", async (req, res) => {
  // If streamable session wants SSE stream
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports[sessionId] && StreamableHTTPServerTransport) {
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
    return;
  }

  // Legacy SSE transport
  console.log("[MCP] New legacy SSE connection");
  const sid = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const mcpServer = createServerForSession(sid);
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    console.log(`[MCP] SSE session closed: ${transport.sessionId}`);
    delete transports[transport.sessionId];
    delete sessions[sid];
  });

  await mcpServer.connect(transport);
  console.log(`[MCP] SSE session created: ${transport.sessionId}`);
});

// ---- SSE LEGACY (POST /messages) ----
app.post("/messages", async (req, res) => {
  const sid = req.query.sessionId;
  console.log(`[MCP] POST /messages sid=${sid}`);
  const t = transports[sid];
  if (!t) return res.status(404).json({ error: "Session not found" });
  try {
    await t.handlePostMessage(req, res);
  } catch (e) {
    console.error(`[MCP] Error:`, e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ---- DELETE session ----
app.delete("/sse", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports[sessionId]) {
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
    return;
  }
  res.status(404).json({ error: "Session not found" });
});

// ---- HEALTH ----
app.get("/health", (req, res) => res.json({
  status: "ok",
  version: "2.0.0",
  streamableHttp: !!StreamableHTTPServerTransport,
  activeSessions: Object.keys(transports).length,
}));

app.listen(PORT, () => {
  console.log(`\n  BC MCP Server v2.0`);
  console.log(`  Transports: SSE${StreamableHTTPServerTransport ? " + Streamable HTTP" : ""}`);
  console.log(`  Port: ${PORT}\n`);
});
