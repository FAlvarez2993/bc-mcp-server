import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

const PORT = process.env.PORT || 3001;
const sessions = {};

function getSession(transport) {
  if (!sessions[transport.sessionId]) sessions[transport.sessionId] = { connected: false };
  return sessions[transport.sessionId];
}

async function getToken(sess) {
  if (!sess.connected) throw new Error("No conectado. Usa bc_connect primero.");
  if (sess.token && Date.now() < sess.tokenExpiry) return sess.token;
  const r = await fetch(`https://login.microsoftonline.com/${sess.tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: sess.clientId, client_secret: sess.clientSecret, scope: sess.scope || "https://api.businesscentral.dynamics.com/.default" }),
  });
  if (!r.ok) throw new Error(`Auth ${r.status}: ${await r.text()}`);
  const d = await r.json();
  sess.token = d.access_token;
  sess.tokenExpiry = Date.now() + (d.expires_in - 120) * 1000;
  return sess.token;
}

function apiBase(sess) { return `https://api.businesscentral.dynamics.com/v2.0/${sess.tenant}/${sess.environment}/api/v2.0`; }

async function bcGet(sess, endpoint, params = {}) {
  const tk = await getToken(sess);
  const qp = [];
  if (params.top) qp.push(`$top=${params.top}`);
  if (params.filter) qp.push(`$filter=${encodeURIComponent(params.filter)}`);
  if (params.select) qp.push(`$select=${params.select}`);
  if (params.orderby) qp.push(`$orderby=${encodeURIComponent(params.orderby)}`);
  const qs = qp.length ? `?${qp.join("&")}` : "";
  const url = `${apiBase(sess)}/${endpoint}${qs}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`BC ${r.status}: ${(await r.text()).substring(0, 500)}`);
  const d = await r.json();
  return d.value || d;
}

async function bcPost(sess, endpoint, payload) {
  const tk = await getToken(sess);
  const url = `${apiBase(sess)}/${endpoint}`;
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`BC POST ${r.status}: ${(await r.text()).substring(0, 500)}`);
  return r.json();
}

async function bcPatch(sess, endpoint, payload, etag) {
  const tk = await getToken(sess);
  const url = `${apiBase(sess)}/${endpoint}`;
  const r = await fetch(url, { method: "PATCH", headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json", Accept: "application/json", "If-Match": etag }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`BC PATCH ${r.status}: ${(await r.text()).substring(0, 500)}`);
  return r.json();
}

const server = new McpServer({ name: "business-central", version: "2.0.0" });

server.tool("bc_connect", "Conecta con cualquier tenant de Business Central. Necesario antes de usar las demas herramientas.", {
  tenant: z.string().describe("Tenant ID (GUID)"),
  environment: z.string().describe("Entorno: Production, Sandbox, etc."),
  clientId: z.string().describe("Client ID de Azure AD"),
  clientSecret: z.string().describe("Client Secret"),
  scope: z.string().optional().default("https://api.businesscentral.dynamics.com/.default"),
}, async ({ tenant, environment, clientId, clientSecret, scope }, { transport }) => {
  const sess = getSession(transport);
  Object.assign(sess, { tenant, environment, clientId, clientSecret, scope, token: null, tokenExpiry: 0 });
  try { await getToken(sess); sess.connected = true; return { content: [{ type: "text", text: `Conectado!\nTenant: ${tenant}\nEntorno: ${environment}` }] }; }
  catch (e) { sess.connected = false; return { content: [{ type: "text", text: `Error: ${e.message}` }] }; }
});

server.tool("bc_status", "Estado de la conexion actual", {}, async (_, { transport }) => {
  const sess = getSession(transport);
  if (!sess.connected) return { content: [{ type: "text", text: "No conectado. Usa bc_connect." }] };
  return { content: [{ type: "text", text: `Conectado: ${sess.tenant} / ${sess.environment}` }] };
});

server.tool("bc_list_companies", "Lista empresas del tenant conectado", {}, async (_, { transport }) => {
  const sess = getSession(transport);
  const data = await bcGet(sess, "companies");
  return { content: [{ type: "text", text: JSON.stringify(data.map(c => ({ id: c.id, name: c.name, displayName: c.displayName })), null, 2) }] };
});

server.tool("bc_query", "Consulta cualquier entidad de BC", {
  companyId: z.string().describe("ID empresa (GUID)"),
  entity: z.string().describe("customers, vendors, items, salesInvoices, salesOrders, purchaseOrders, accounts, employees, bankAccounts, etc."),
  top: z.number().optional().default(20),
  filter: z.string().optional().describe("Filtro OData"),
  select: z.string().optional().describe("Campos a devolver"),
  orderby: z.string().optional().describe("Orden"),
}, async ({ companyId, entity, top, filter, select, orderby }, { transport }) => {
  const data = await bcGet(getSession(transport), `companies(${companyId})/${entity}`, { top, filter, select, orderby });
  return { content: [{ type: "text", text: `${entity}: ${data.length} registros\n\n${JSON.stringify(data, null, 2)}` }] };
});

server.tool("bc_customer_summary", "Resumen financiero de un cliente", {
  companyId: z.string(), customerNumber: z.string(),
}, async ({ companyId, customerNumber }, { transport }) => {
  const sess = getSession(transport); const b = `companies(${companyId})`;
  const cust = await bcGet(sess, `${b}/customers`, { filter: `number eq '${customerNumber}'` });
  if (!cust.length) return { content: [{ type: "text", text: "Cliente no encontrado" }] };
  const inv = await bcGet(sess, `${b}/salesInvoices`, { filter: `customerNumber eq '${customerNumber}'`, top: 10, orderby: "invoiceDate desc" });
  return { content: [{ type: "text", text: JSON.stringify({ customer: cust[0], recentInvoices: inv }, null, 2) }] };
});

server.tool("bc_sales_summary", "Resumen de ventas", { companyId: z.string(), top: z.number().optional().default(20) }, async ({ companyId, top }, { transport }) => {
  const inv = await bcGet(getSession(transport), `companies(${companyId})/salesInvoices`, { top, orderby: "invoiceDate desc", select: "number,invoiceDate,customerName,totalAmountIncludingTax,status,remainingAmount" });
  const total = inv.reduce((s, i) => s + (i.totalAmountIncludingTax || 0), 0);
  const pending = inv.reduce((s, i) => s + (i.remainingAmount || 0), 0);
  return { content: [{ type: "text", text: JSON.stringify({ invoiceCount: inv.length, totalSales: total, totalPending: pending, recent: inv.slice(0, 5) }, null, 2) }] };
});

server.tool("bc_create", "Crear registro en BC", {
  companyId: z.string(), entity: z.string(), data: z.string().describe("JSON del registro"),
}, async ({ companyId, entity, data }, { transport }) => {
  const result = await bcPost(getSession(transport), `companies(${companyId})/${entity}`, JSON.parse(data));
  return { content: [{ type: "text", text: `Creado:\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool("bc_update", "Actualizar registro en BC", {
  companyId: z.string(), entity: z.string(), entityId: z.string(), etag: z.string(), data: z.string(),
}, async ({ companyId, entity, entityId, etag, data }, { transport }) => {
  const result = await bcPatch(getSession(transport), `companies(${companyId})/${entity}(${entityId})`, JSON.parse(data), etag);
  return { content: [{ type: "text", text: `Actualizado:\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool("bc_custom", "Consulta APIs personalizadas", {
  url: z.string(), top: z.number().optional().default(20), filter: z.string().optional(),
}, async ({ url, top, filter }, { transport }) => {
  const sess = getSession(transport);
  const full = url.startsWith("http") ? url : `${apiBase(sess)}/${url}`;
  const qp = []; if (top) qp.push(`$top=${top}`); if (filter) qp.push(`$filter=${encodeURIComponent(filter)}`);
  const tk = await getToken(sess);
  const r = await fetch(`${full}${qp.length ? "?" + qp.join("&") : ""}`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`BC ${r.status}: ${(await r.text()).substring(0, 500)}`);
  const d = await r.json(); const records = d.value || d;
  return { content: [{ type: "text", text: `${Array.isArray(records) ? records.length : 1} registros:\n${JSON.stringify(records, null, 2)}` }] };
});

const app = express();
const transports = {};
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => { delete transports[transport.sessionId]; delete sessions[transport.sessionId]; });
  await server.connect(transport);
});
app.post("/messages", express.json(), async (req, res) => {
  const t = transports[req.query.sessionId];
  if (!t) return res.status(404).json({ error: "Session not found" });
  await t.handlePostMessage(req, res);
});
app.get("/health", (req, res) => res.json({ status: "ok", version: "2.0.0", mode: "multi-tenant", sessions: Object.keys(sessions).length }));
app.listen(PORT, () => console.log(`BC MCP v2.0 Multi-tenant on port ${PORT}`));
