import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

const PORT = process.env.PORT || 3001;

// Global session - stores current BC connection
const sess = { connected: false, tenant: null, environment: null, clientId: null, clientSecret: null, scope: null, token: null, tokenExpiry: 0 };

async function getToken() {
  if (!sess.connected) throw new Error("No conectado a BC. Usa bc_connect primero con tenant, environment, clientId y clientSecret.");
  if (sess.token && Date.now() < sess.tokenExpiry) return sess.token;
  console.log("[AUTH] Getting token for " + sess.tenant.substring(0, 8) + "...");
  const r = await fetch("https://login.microsoftonline.com/" + sess.tenant + "/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: sess.clientId, client_secret: sess.clientSecret, scope: sess.scope || "https://api.businesscentral.dynamics.com/.default" }),
  });
  if (!r.ok) throw new Error("Auth " + r.status + ": " + (await r.text()));
  const d = await r.json();
  sess.token = d.access_token;
  sess.tokenExpiry = Date.now() + (d.expires_in - 120) * 1000;
  console.log("[AUTH] Token OK, expires in " + d.expires_in + "s");
  return sess.token;
}

function apiBase() { return "https://api.businesscentral.dynamics.com/v2.0/" + sess.tenant + "/" + sess.environment + "/api/v2.0"; }

async function bcGet(endpoint, params) {
  params = params || {};
  const tk = await getToken();
  const qp = [];
  if (params.top) qp.push("$top=" + params.top);
  if (params.filter) qp.push("$filter=" + encodeURIComponent(params.filter));
  if (params.select) qp.push("$select=" + params.select);
  if (params.orderby) qp.push("$orderby=" + encodeURIComponent(params.orderby));
  const qs = qp.length ? "?" + qp.join("&") : "";
  const url = apiBase() + "/" + endpoint + qs;
  console.log("[BC] GET " + url);
  const r = await fetch(url, { headers: { Authorization: "Bearer " + tk, Accept: "application/json" } });
  if (!r.ok) throw new Error("BC " + r.status + ": " + (await r.text()).substring(0, 500));
  const d = await r.json();
  return d.value || d;
}

async function bcPost(endpoint, payload) {
  const tk = await getToken();
  const url = apiBase() + "/" + endpoint;
  const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error("BC POST " + r.status + ": " + (await r.text()).substring(0, 500));
  return r.json();
}

async function bcPatch(endpoint, payload, etag) {
  const tk = await getToken();
  const url = apiBase() + "/" + endpoint;
  const r = await fetch(url, { method: "PATCH", headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json", Accept: "application/json", "If-Match": etag }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error("BC PATCH " + r.status + ": " + (await r.text()).substring(0, 500));
  return r.json();
}

const server = new McpServer({ name: "business-central", version: "2.0.0" });

server.tool("bc_connect", "Conecta con cualquier tenant de Business Central. Necesario antes de usar las demas herramientas.", {
  tenant: z.string().describe("Tenant ID (GUID)"),
  environment: z.string().describe("Entorno: Production, Sandbox"),
  clientId: z.string().describe("Client ID de Azure AD"),
  clientSecret: z.string().describe("Client Secret de Azure AD"),
}, async (params) => {
  sess.tenant = params.tenant;
  sess.environment = params.environment;
  sess.clientId = params.clientId;
  sess.clientSecret = params.clientSecret;
  sess.scope = "https://api.businesscentral.dynamics.com/.default";
  sess.token = null;
  sess.tokenExpiry = 0;
  try { await getToken(); sess.connected = true; return { content: [{ type: "text", text: "Conectado a BC!\nTenant: " + params.tenant + "\nEntorno: " + params.environment }] }; }
  catch (e) { sess.connected = false; return { content: [{ type: "text", text: "Error: " + e.message }] }; }
});

server.tool("bc_status", "Estado de la conexion actual", {}, async () => {
  if (!sess.connected) return { content: [{ type: "text", text: "No conectado. Usa bc_connect." }] };
  return { content: [{ type: "text", text: "Conectado: " + sess.tenant + " / " + sess.environment }] };
});

server.tool("bc_list_companies", "Lista empresas del tenant conectado", {}, async () => {
  const data = await bcGet("companies");
  return { content: [{ type: "text", text: JSON.stringify(data.map(function(c) { return { id: c.id, name: c.name, displayName: c.displayName }; }), null, 2) }] };
});

server.tool("bc_query", "Consulta cualquier entidad de BC", {
  companyId: z.string().describe("ID empresa (GUID)"),
  entity: z.string().describe("customers, vendors, items, salesInvoices, salesOrders, purchaseOrders, accounts, employees, bankAccounts, companyInformation, agedAccountsReceivables, agedAccountsPayables, etc."),
  top: z.number().optional().default(20),
  filter: z.string().optional().describe("Filtro OData"),
  select: z.string().optional().describe("Campos a devolver"),
  orderby: z.string().optional().describe("Orden"),
}, async (p) => {
  const data = await bcGet("companies(" + p.companyId + ")/" + p.entity, { top: p.top, filter: p.filter, select: p.select, orderby: p.orderby });
  return { content: [{ type: "text", text: p.entity + ": " + data.length + " registros\n\n" + JSON.stringify(data, null, 2) }] };
});

server.tool("bc_customer_summary", "Resumen financiero de un cliente", {
  companyId: z.string(), customerNumber: z.string(),
}, async (p) => {
  var b = "companies(" + p.companyId + ")";
  var cust = await bcGet(b + "/customers", { filter: "number eq '" + p.customerNumber + "'" });
  if (!cust.length) return { content: [{ type: "text", text: "Cliente no encontrado" }] };
  var inv = await bcGet(b + "/salesInvoices", { filter: "customerNumber eq '" + p.customerNumber + "'", top: 10, orderby: "invoiceDate desc" });
  return { content: [{ type: "text", text: JSON.stringify({ customer: cust[0], recentInvoices: inv }, null, 2) }] };
});

server.tool("bc_sales_summary", "Resumen de ventas", { companyId: z.string(), top: z.number().optional().default(20) }, async (p) => {
  var inv = await bcGet("companies(" + p.companyId + ")/salesInvoices", { top: p.top, orderby: "invoiceDate desc", select: "number,invoiceDate,customerName,totalAmountIncludingTax,status,remainingAmount" });
  var total = inv.reduce(function(s, i) { return s + (i.totalAmountIncludingTax || 0); }, 0);
  var pending = inv.reduce(function(s, i) { return s + (i.remainingAmount || 0); }, 0);
  return { content: [{ type: "text", text: JSON.stringify({ invoiceCount: inv.length, totalSales: total, totalPending: pending, recent: inv.slice(0, 5) }, null, 2) }] };
});

server.tool("bc_create", "Crear registro en BC", {
  companyId: z.string(), entity: z.string(), data: z.string().describe("JSON del registro"),
}, async (p) => {
  var result = await bcPost("companies(" + p.companyId + ")/" + p.entity, JSON.parse(p.data));
  return { content: [{ type: "text", text: "Creado:\n" + JSON.stringify(result, null, 2) }] };
});

server.tool("bc_update", "Actualizar registro en BC", {
  companyId: z.string(), entity: z.string(), entityId: z.string(), etag: z.string(), data: z.string(),
}, async (p) => {
  var result = await bcPatch("companies(" + p.companyId + ")/" + p.entity + "(" + p.entityId + ")", JSON.parse(p.data), p.etag);
  return { content: [{ type: "text", text: "Actualizado:\n" + JSON.stringify(result, null, 2) }] };
});

server.tool("bc_custom", "Consulta APIs personalizadas", {
  url: z.string(), top: z.number().optional().default(20), filter: z.string().optional(),
}, async (p) => {
  var full = p.url.startsWith("http") ? p.url : apiBase() + "/" + p.url;
  var qp = []; if (p.top) qp.push("$top=" + p.top); if (p.filter) qp.push("$filter=" + encodeURIComponent(p.filter));
  var tk = await getToken();
  var r = await fetch(full + (qp.length ? "?" + qp.join("&") : ""), { headers: { Authorization: "Bearer " + tk, Accept: "application/json" } });
  if (!r.ok) throw new Error("BC " + r.status + ": " + (await r.text()).substring(0, 500));
  var d = await r.json(); var records = d.value || d;
  return { content: [{ type: "text", text: (Array.isArray(records) ? records.length : 1) + " registros:\n" + JSON.stringify(records, null, 2) }] };
});

var app = express();
var transports = {};
app.get("/sse", async function(req, res) {
  console.log("[MCP] New SSE connection");
  var transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", function() { delete transports[transport.sessionId]; });
  await server.connect(transport);
});
app.post("/messages", express.json(), async function(req, res) {
  var t = transports[req.query.sessionId];
  if (!t) return res.status(404).json({ error: "Session not found" });
  await t.handlePostMessage(req, res);
});
app.get("/health", function(req, res) { res.json({ status: "ok", version: "2.1.0", mode: "multi-tenant", connected: sess.connected, tenant: sess.tenant }); });
app.listen(PORT, function() { console.log("BC MCP v2.1 on port " + PORT); });
