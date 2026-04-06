import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

const PORT = process.env.PORT || 3001;

// ============ SESSION STORE ============
// Each SSE session can have its own BC connection
const sessions = {};

function getSession(transport) {
  if (!sessions[transport.sessionId]) {
    sessions[transport.sessionId] = { connected: false };
  }
  return sessions[transport.sessionId];
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

// ============ MCP SERVER ============
const server = new McpServer({ name: "business-central", version: "2.0.0" });

// Tool: Connect to any BC tenant
server.tool("bc_connect", "Conecta con un tenant de Business Central. Necesario antes de usar cualquier otra herramienta. Las credenciales se usan solo durante esta sesion.", {
  tenant: z.string().describe("Tenant ID (GUID) de Azure AD"),
  environment: z.string().describe("Nombre del entorno: Production, Sandbox, etc."),
  clientId: z.string().describe("Client ID de la App Registration en Azure AD"),
  clientSecret: z.string().describe("Client Secret de la App Registration"),
  scope: z.string().optional().default("https://api.businesscentral.dynamics.com/.default").describe("Scope OAuth2"),
}, async ({ tenant, environment, clientId, clientSecret, scope }, { transport }) => {
  const sess = getSession(transport);
  sess.tenant = tenant;
  sess.environment = environment;
  sess.clientId = clientId;
  sess.clientSecret = clientSecret;
  sess.scope = scope;
  sess.token = null;
  sess.tokenExpiry = 0;

  // Test connection
  try {
    await getToken(sess);
    sess.connected = true;
    return { content: [{ type: "text", text: `Conectado a BC!\nTenant: ${tenant}\nEntorno: ${environment}\nToken OK` }] };
  } catch (e) {
    sess.connected = false;
    return { content: [{ type: "text", text: `Error de conexion: ${e.message}` }] };
  }
});

// Tool: List companies
server.tool("bc_list_companies", "Lista empresas disponibles en el tenant conectado", {}, async (_, { transport }) => {
  const sess = getSession(transport);
  const data = await bcGet(sess, "companies");
  return { content: [{ type: "text", text: JSON.stringify(data.map(c => ({ id: c.id, name: c.name, displayName: c.displayName })), null, 2) }] };
});

// Tool: Query any entity
server.tool("bc_query", "Consulta cualquier entidad de BC: customers, vendors, items, salesInvoices, salesOrders, purchaseOrders, accounts, generalLedgerEntries, employees, bankAccounts, agedAccountsReceivables, agedAccountsPayables, companyInformation, etc.", {
  companyId: z.string().describe("ID empresa (GUID). Usa bc_list_companies para obtenerlo"),
  entity: z.string().describe("Entidad: customers, vendors, items, salesOrders, salesInvoices, purchaseOrders, accounts, generalLedgerEntries, employees, bankAccounts, companyInformation, etc."),
  top: z.number().optional().default(20),
  filter: z.string().optional().describe("Filtro OData: balanceDue gt 0, city eq 'Madrid'"),
  select: z.string().optional().describe("Campos: displayName,number,email"),
  orderby: z.string().optional().describe("Orden: balanceDue desc"),
}, async ({ companyId, entity, top, filter, select, orderby }, { transport }) => {
  const sess = getSession(transport);
  const data = await bcGet(sess, `companies(${companyId})/${entity}`, { top, filter, select, orderby });
  return { content: [{ type: "text", text: `${entity}: ${data.length} registros\n\n${JSON.stringify(data, null, 2)}` }] };
});

// Tool: Customer summary
server.tool("bc_customer_summary", "Resumen financiero de un cliente con facturas y antigüedad de deuda", {
  companyId: z.string(),
  customerNumber: z.string().describe("Numero del cliente"),
}, async ({ companyId, customerNumber }, { transport }) => {
  const sess = getSession(transport);
  const b = `companies(${companyId})`;
  const cust = await bcGet(sess, `${b}/customers`, { filter: `number eq '${customerNumber}'` });
  if (!cust.length) return { content: [{ type: "text", text: `Cliente ${customerNumber} no encontrado` }] };
  const inv = await bcGet(sess, `${b}/salesInvoices`, { filter: `customerNumber eq '${customerNumber}'`, top: 10, orderby: "invoiceDate desc" });
  const aged = await bcGet(sess, `${b}/agedAccountsReceivables`, { filter: `customerNumber eq '${customerNumber}'` });
  return { content: [{ type: "text", text: JSON.stringify({ customer: cust[0], recentInvoices: inv, aging: aged }, null, 2) }] };
});

// Tool: Inventory
server.tool("bc_inventory", "Estado del inventario: articulos con bajo stock, valoracion total", {
  companyId: z.string(),
  lowStockThreshold: z.number().optional().default(10),
}, async ({ companyId, lowStockThreshold }, { transport }) => {
  const sess = getSession(transport);
  const items = await bcGet(sess, `companies(${companyId})/items`, { top: 100, select: "displayName,number,inventory,unitPrice,unitCost,itemCategoryCode" });
  const low = items.filter(i => i.inventory <= lowStockThreshold && i.inventory >= 0);
  const totalVal = items.reduce((s, i) => s + (i.inventory || 0) * (i.unitCost || 0), 0);
  return { content: [{ type: "text", text: JSON.stringify({ totalItems: items.length, totalValue: totalVal, lowStock: low, topByValue: items.map(i => ({ ...i, value: (i.inventory || 0) * (i.unitCost || 0) })).sort((a, b) => b.value - a.value).slice(0, 10) }, null, 2) }] };
});

// Tool: Sales summary
server.tool("bc_sales_summary", "Resumen de ventas: facturas, totales, pendiente de cobro, top clientes", {
  companyId: z.string(),
  top: z.number().optional().default(20),
}, async ({ companyId, top }, { transport }) => {
  const sess = getSession(transport);
  const inv = await bcGet(sess, `companies(${companyId})/salesInvoices`, { top, orderby: "invoiceDate desc", select: "number,invoiceDate,customerName,totalAmountIncludingTax,status,remainingAmount" });
  const total = inv.reduce((s, i) => s + (i.totalAmountIncludingTax || 0), 0);
  const pending = inv.reduce((s, i) => s + (i.remainingAmount || 0), 0);
  const byCust = {};
  inv.forEach(i => { if (!byCust[i.customerName]) byCust[i.customerName] = { total: 0, count: 0 }; byCust[i.customerName].total += i.totalAmountIncludingTax || 0; byCust[i.customerName].count++; });
  return { content: [{ type: "text", text: JSON.stringify({ invoiceCount: inv.length, totalSales: total, totalPending: pending, topCustomers: Object.entries(byCust).map(([n, d]) => ({ name: n, ...d })).sort((a, b) => b.total - a.total).slice(0, 10), recent: inv.slice(0, 5) }, null, 2) }] };
});

// Tool: Create record
server.tool("bc_create", "Crear un nuevo registro en BC (cliente, articulo, pedido, factura...)", {
  companyId: z.string(),
  entity: z.string().describe("customers, items, salesOrders, salesInvoices, etc."),
  data: z.string().describe("JSON con los datos del nuevo registro"),
}, async ({ companyId, entity, data }, { transport }) => {
  const sess = getSession(transport);
  const result = await bcPost(sess, `companies(${companyId})/${entity}`, JSON.parse(data));
  return { content: [{ type: "text", text: `Creado OK:\n${JSON.stringify(result, null, 2)}` }] };
});

// Tool: Update record
server.tool("bc_update", "Actualizar un registro existente en BC", {
  companyId: z.string(),
  entity: z.string(),
  entityId: z.string().describe("GUID del registro"),
  etag: z.string().describe("ETag del registro (se obtiene con bc_query)"),
  data: z.string().describe("JSON con campos a actualizar"),
}, async ({ companyId, entity, entityId, etag, data }, { transport }) => {
  const sess = getSession(transport);
  const result = await bcPatch(sess, `companies(${companyId})/${entity}(${entityId})`, JSON.parse(data), etag);
  return { content: [{ type: "text", text: `Actualizado OK:\n${JSON.stringify(result, null, 2)}` }] };
});

// Tool: Custom API query
server.tool("bc_custom", "Consulta APIs personalizadas de BC (custom AL pages)", {
  url: z.string().describe("Ruta relativa desde api/v2.0/ o URL completa. Ej: companies({id})/itemLedgerEntries o api/ESDEN/app1/v2.0/companies({id})/jobESDEN"),
  top: z.number().optional().default(20),
  filter: z.string().optional(),
}, async ({ url, top, filter }, { transport }) => {
  const sess = getSession(transport);
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

// Tool: Connection status
server.tool("bc_status", "Muestra el estado de la conexion actual", {}, async (_, { transport }) => {
  const sess = getSession(transport);
  if (!sess.connected) return { content: [{ type: "text", text: "No conectado. Usa bc_connect con las credenciales del tenant." }] };
  return { content: [{ type: "text", text: `Conectado:\n  Tenant: ${sess.tenant}\n  Entorno: ${sess.environment}\n  Token: ${sess.token ? "Activo" : "Expirado"}\n  Expira: ${sess.tokenExpiry ? new Date(sess.tokenExpiry).toLocaleTimeString() : "N/A"}` }] };
});

// ============ EXPRESS + SSE ============
const app = express();
const transports = {};

app.get("/sse", async (req, res) => {
  console.log("[MCP] New SSE connection");
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => {
    delete transports[transport.sessionId];
    delete sessions[transport.sessionId];
  });
  await server.connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
  const sid = req.query.sessionId;
  const t = transports[sid];
  if (!t) return res.status(404).json({ error: "Session not found" });
  await t.handlePostMessage(req, res);
});

app.get("/health", (req, res) => res.json({
  status: "ok",
  version: "2.0.0",
  mode: "multi-tenant",
  activeSessions: Object.keys(sessions).length,
  tools: ["bc_connect", "bc_status", "bc_list_companies", "bc_query", "bc_customer_summary", "bc_inventory", "bc_sales_summary", "bc_create", "bc_update", "bc_custom"],
}));

app.listen(PORT, () => {
  console.log(`\n  BC MCP Server v2.0 (Multi-tenant)`);
  console.log(`  Mode: Dynamic - any tenant`);
  console.log(`  SSE: http://localhost:${PORT}/sse`);
  console.log(`  Health: http://localhost:${PORT}/health\n`);
});
