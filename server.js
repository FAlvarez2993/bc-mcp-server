import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import { readFileSync } from "fs";

try {
  readFileSync(".env", "utf8").split("\n").forEach(line => {
    const [k, ...v] = line.split("=");
    if (k && v.length) process.env[k.trim()] = v.join("=").trim();
  });
} catch {}

const CFG = {
  TENANT: process.env.BC_TENANT_ID,
  ENV: process.env.BC_ENVIRONMENT || "Sandbox",
  CLIENT_ID: process.env.BC_CLIENT_ID,
  CLIENT_SECRET: process.env.BC_CLIENT_SECRET,
  SCOPE: process.env.BC_SCOPE || "https://api.businesscentral.dynamics.com/.default",
  PORT: process.env.PORT || 3001,
};

const API_BASE = `https://api.businesscentral.dynamics.com/v2.0/${CFG.TENANT}/${CFG.ENV}/api/v2.0`;
const TOKEN_URL = `https://login.microsoftonline.com/${CFG.TENANT}/oauth2/v2.0/token`;

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  console.log("[AUTH] Requesting token...");
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CFG.CLIENT_ID,
      client_secret: CFG.CLIENT_SECRET,
      scope: CFG.SCOPE,
    }),
  });
  if (!r.ok) throw new Error(`Auth ${r.status}: ${await r.text()}`);
  const d = await r.json();
  cachedToken = d.access_token;
  tokenExpiry = Date.now() + (d.expires_in - 120) * 1000;
  console.log(`[AUTH] Token OK, expires in ${d.expires_in}s`);
  return cachedToken;
}

async function bcGet(endpoint, params = {}) {
  const tk = await getToken();
  const qp = [];
  if (params.top) qp.push(`$top=${params.top}`);
  if (params.filter) qp.push(`$filter=${encodeURIComponent(params.filter)}`);
  if (params.select) qp.push(`$select=${params.select}`);
  if (params.orderby) qp.push(`$orderby=${encodeURIComponent(params.orderby)}`);
  const qs = qp.length ? `?${qp.join("&")}` : "";
  const url = `${API_BASE}/${endpoint}${qs}`;
  console.log(`[BC] GET ${url}`);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`BC ${r.status}: ${(await r.text()).substring(0, 500)}`);
  const d = await r.json();
  return d.value || d;
}

async function bcPost(endpoint, payload) {
  const tk = await getToken();
  const url = `${API_BASE}/${endpoint}`;
  console.log(`[BC] POST ${url}`);
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`BC POST ${r.status}: ${(await r.text()).substring(0, 500)}`);
  return r.json();
}

async function bcPatch(endpoint, payload, etag) {
  const tk = await getToken();
  const url = `${API_BASE}/${endpoint}`;
  console.log(`[BC] PATCH ${url}`);
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json", Accept: "application/json", "If-Match": etag },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`BC PATCH ${r.status}: ${(await r.text()).substring(0, 500)}`);
  return r.json();
}

const server = new McpServer({ name: "business-central", version: "1.0.0" });

server.tool("bc_list_companies", "Lista empresas disponibles en Business Central", {}, async () => {
  const data = await bcGet("companies");
  return { content: [{ type: "text", text: JSON.stringify(data.map(c => ({ id: c.id, name: c.name, displayName: c.displayName })), null, 2) }] };
});

server.tool("bc_query", "Consulta cualquier entidad de BC: customers, vendors, items, salesInvoices, salesOrders, purchaseOrders, accounts, generalLedgerEntries, employees, bankAccounts, agedAccountsReceivables, agedAccountsPayables, etc.", {
  companyId: z.string().describe("ID empresa (GUID). Usa bc_list_companies para obtenerlo"),
  entity: z.string().describe("Entidad: customers, vendors, items, salesOrders, salesInvoices, purchaseOrders, accounts, generalLedgerEntries, employees, bankAccounts, etc."),
  top: z.number().optional().default(20),
  filter: z.string().optional().describe("Filtro OData: balanceDue gt 0, city eq 'Madrid'"),
  select: z.string().optional().describe("Campos: displayName,number,email"),
  orderby: z.string().optional().describe("Orden: balanceDue desc"),
}, async ({ companyId, entity, top, filter, select, orderby }) => {
  const data = await bcGet(`companies(${companyId})/${entity}`, { top, filter, select, orderby });
  return { content: [{ type: "text", text: `${entity}: ${data.length} registros\n\n${JSON.stringify(data, null, 2)}` }] };
});

server.tool("bc_customer_summary", "Resumen financiero completo de un cliente con facturas recientes y antigüedad de deuda", {
  companyId: z.string(),
  customerNumber: z.string().describe("Numero del cliente"),
}, async ({ companyId, customerNumber }) => {
  const b = `companies(${companyId})`;
  const cust = await bcGet(`${b}/customers`, { filter: `number eq '${customerNumber}'` });
  if (!cust.length) return { content: [{ type: "text", text: `Cliente ${customerNumber} no encontrado` }] };
  const inv = await bcGet(`${b}/salesInvoices`, { filter: `customerNumber eq '${customerNumber}'`, top: 10, orderby: "invoiceDate desc" });
  const aged = await bcGet(`${b}/agedAccountsReceivables`, { filter: `customerNumber eq '${customerNumber}'` });
  return { content: [{ type: "text", text: JSON.stringify({ customer: cust[0], recentInvoices: inv, aging: aged }, null, 2) }] };
});

server.tool("bc_inventory", "Estado del inventario: articulos con bajo stock, valoracion total, top articulos", {
  companyId: z.string(),
  lowStockThreshold: z.number().optional().default(10),
}, async ({ companyId, lowStockThreshold }) => {
  const items = await bcGet(`companies(${companyId})/items`, { top: 100, select: "displayName,number,inventory,unitPrice,unitCost,itemCategoryCode" });
  const low = items.filter(i => i.inventory <= lowStockThreshold && i.inventory >= 0);
  const totalVal = items.reduce((s, i) => s + (i.inventory || 0) * (i.unitCost || 0), 0);
  return { content: [{ type: "text", text: JSON.stringify({ totalItems: items.length, totalValue: totalVal, lowStock: low, topByValue: items.map(i => ({ ...i, value: (i.inventory || 0) * (i.unitCost || 0) })).sort((a, b) => b.value - a.value).slice(0, 10) }, null, 2) }] };
});

server.tool("bc_sales_summary", "Resumen de ventas: facturas recientes, totales, pendiente de cobro, top clientes", {
  companyId: z.string(),
  top: z.number().optional().default(20),
}, async ({ companyId, top }) => {
  const inv = await bcGet(`companies(${companyId})/salesInvoices`, { top, orderby: "invoiceDate desc", select: "number,invoiceDate,customerName,totalAmountIncludingTax,status,remainingAmount" });
  const total = inv.reduce((s, i) => s + (i.totalAmountIncludingTax || 0), 0);
  const pending = inv.reduce((s, i) => s + (i.remainingAmount || 0), 0);
  const byCust = {};
  inv.forEach(i => { if (!byCust[i.customerName]) byCust[i.customerName] = { total: 0, count: 0 }; byCust[i.customerName].total += i.totalAmountIncludingTax || 0; byCust[i.customerName].count++; });
  return { content: [{ type: "text", text: JSON.stringify({ invoiceCount: inv.length, totalSales: total, totalPending: pending, topCustomers: Object.entries(byCust).map(([n, d]) => ({ name: n, ...d })).sort((a, b) => b.total - a.total).slice(0, 10), recent: inv.slice(0, 5) }, null, 2) }] };
});

server.tool("bc_create", "Crear un nuevo registro en BC (cliente, articulo, pedido, factura...)", {
  companyId: z.string(),
  entity: z.string().describe("customers, items, salesOrders, salesInvoices, etc."),
  data: z.string().describe("JSON con los datos del nuevo registro"),
}, async ({ companyId, entity, data }) => {
  const result = await bcPost(`companies(${companyId})/${entity}`, JSON.parse(data));
  return { content: [{ type: "text", text: `Creado OK:\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool("bc_update", "Actualizar un registro existente en BC", {
  companyId: z.string(),
  entity: z.string(),
  entityId: z.string().describe("GUID del registro"),
  etag: z.string().describe("ETag del registro (se obtiene con bc_query)"),
  data: z.string().describe("JSON con campos a actualizar"),
}, async ({ companyId, entity, entityId, etag, data }) => {
  const result = await bcPatch(`companies(${companyId})/${entity}(${entityId})`, JSON.parse(data), etag);
  return { content: [{ type: "text", text: `Actualizado OK:\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool("bc_custom", "Consulta APIs personalizadas de BC (custom AL pages, ej: api/ESDEN/app1/v2.0/...)", {
  url: z.string().describe("Ruta relativa o URL completa"),
  top: z.number().optional().default(20),
  filter: z.string().optional(),
}, async ({ url, top, filter }) => {
  const full = url.startsWith("http") ? url : `${API_BASE}/${url}`;
  const qp = [];
  if (top) qp.push(`$top=${top}`);
  if (filter) qp.push(`$filter=${encodeURIComponent(filter)}`);
  const qs = qp.length ? `?${qp.join("&")}` : "";
  const tk = await getToken();
  const r = await fetch(`${full}${qs}`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`BC ${r.status}: ${(await r.text()).substring(0, 500)}`);
  const d = await r.json();
  const records = d.value || d;
  return { content: [{ type: "text", text: `${Array.isArray(records) ? records.length : 1} registros:\n${JSON.stringify(records, null, 2)}` }] };
});

const app = express();
const transports = {};

app.get("/sse", async (req, res) => {
  console.log("[MCP] New SSE connection");
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => { delete transports[transport.sessionId]; });
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
  env: CFG.ENV,
  tenant: CFG.TENANT ? CFG.TENANT.substring(0, 8) + "..." : "not set",
  tools: ["bc_list_companies", "bc_query", "bc_customer_summary", "bc_inventory", "bc_sales_summary", "bc_create", "bc_update", "bc_custom"],
}));

app.listen(CFG.PORT, () => {
  console.log(`\n  MCP Server for Business Central`);
  console.log(`  Environment: ${CFG.ENV}`);
  console.log(`  Tenant: ${CFG.TENANT}`);
  console.log(`  SSE: http://localhost:${CFG.PORT}/sse`);
  console.log(`  Health: http://localhost:${CFG.PORT}/health\n`);
});
