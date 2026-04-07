import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import { randomUUID } from "crypto";

var PORT = process.env.PORT || 3001;

var bc = {
  connected: false, tenant: "", environment: "", clientId: "",
  clientSecret: "", scope: "https://api.businesscentral.dynamics.com/.default",
  token: null, tokenExpiry: 0
};

async function getToken() {
  if (!bc.connected) throw new Error("Not connected. Use bc_connect first.");
  if (bc.token && Date.now() < bc.tokenExpiry) return bc.token;
  var url = "https://login.microsoftonline.com/" + bc.tenant + "/oauth2/v2.0/token";
  var res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials", client_id: bc.clientId,
      client_secret: bc.clientSecret, scope: bc.scope
    })
  });
  if (!res.ok) throw new Error("Auth " + res.status + ": " + (await res.text()).substring(0, 300));
  var d = await res.json();
  bc.token = d.access_token;
  bc.tokenExpiry = Date.now() + (d.expires_in - 120) * 1000;
  console.log("[AUTH] Token OK");
  return bc.token;
}

function apiBase() {
  return "https://api.businesscentral.dynamics.com/v2.0/" + bc.tenant + "/" + bc.environment + "/api/v2.0";
}

async function bcGet(endpoint, opts) {
  var tk = await getToken();
  var qp = [];
  if (opts && opts.top) qp.push("$top=" + opts.top);
  if (opts && opts.filter) qp.push("$filter=" + encodeURIComponent(opts.filter));
  if (opts && opts.select) qp.push("$select=" + opts.select);
  if (opts && opts.orderby) qp.push("$orderby=" + encodeURIComponent(opts.orderby));
  var qs = qp.length ? "?" + qp.join("&") : "";
  var url = apiBase() + "/" + endpoint + qs;
  console.log("[BC] GET " + url);
  var res = await fetch(url, { headers: { Authorization: "Bearer " + tk, Accept: "application/json" } });
  if (!res.ok) throw new Error("BC " + res.status + ": " + (await res.text()).substring(0, 500));
  var d = await res.json();
  return d.value || d;
}

async function bcWrite(method, endpoint, payload, etag) {
  var tk = await getToken();
  var url = apiBase() + "/" + endpoint;
  var headers = { Authorization: "Bearer " + tk, "Content-Type": "application/json", Accept: "application/json" };
  if (etag) headers["If-Match"] = etag;
  var res = await fetch(url, { method: method, headers: headers, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error("BC " + method + " " + res.status + ": " + (await res.text()).substring(0, 500));
  return res.json();
}

var server = new McpServer({ name: "business-central", version: "4.0.0" });

server.tool("bc_connect", "Connect to any Business Central tenant. Required first.", {
  tenant: z.string().describe("Tenant ID (GUID)"),
  environment: z.string().describe("Environment: Production, Sandbox"),
  clientId: z.string().describe("Azure AD Client ID"),
  clientSecret: z.string().describe("Azure AD Client Secret")
}, async function(p) {
  bc.tenant = p.tenant; bc.environment = p.environment;
  bc.clientId = p.clientId; bc.clientSecret = p.clientSecret;
  bc.token = null; bc.tokenExpiry = 0;
  try { await getToken(); bc.connected = true;
    return { content: [{ type: "text", text: "Connected!\nTenant: " + p.tenant + "\nEnv: " + p.environment }] };
  } catch (e) { bc.connected = false;
    return { content: [{ type: "text", text: "Error: " + e.message }] };
  }
});

server.tool("bc_status", "Check connection status", {}, async function() {
  if (!bc.connected) return { content: [{ type: "text", text: "Not connected." }] };
  return { content: [{ type: "text", text: "Connected: " + bc.tenant + " / " + bc.environment }] };
});

server.tool("bc_list_companies", "List companies in connected tenant", {}, async function() {
  var data = await bcGet("companies");
  return { content: [{ type: "text", text: JSON.stringify(data.map(function(c) { return { id: c.id, name: c.name }; }), null, 2) }] };
});

server.tool("bc_query", "Query any BC entity", {
  companyId: z.string().describe("Company ID (GUID)"),
  entity: z.string().describe("Entity: customers, vendors, items, salesInvoices, salesOrders, purchaseInvoices, purchaseOrders, accounts, generalLedgerEntries, employees, bankAccounts, companyInformation, agedAccountsReceivables, agedAccountsPayables, contacts, etc."),
  top: z.number().optional().default(20),
  filter: z.string().optional().describe("OData filter"),
  select: z.string().optional().describe("Fields to return"),
  orderby: z.string().optional().describe("Sort order")
}, async function(p) {
  var data = await bcGet("companies(" + p.companyId + ")/" + p.entity, { top: p.top, filter: p.filter, select: p.select, orderby: p.orderby });
  return { content: [{ type: "text", text: p.entity + ": " + data.length + " records\n\n" + JSON.stringify(data, null, 2) }] };
});

server.tool("bc_customer_summary", "Customer financial summary", {
  companyId: z.string(), customerNumber: z.string()
}, async function(p) {
  var b = "companies(" + p.companyId + ")";
  var c = await bcGet(b + "/customers", { filter: "number eq '" + p.customerNumber + "'" });
  if (!c.length) return { content: [{ type: "text", text: "Not found" }] };
  var inv = await bcGet(b + "/salesInvoices", { filter: "customerNumber eq '" + p.customerNumber + "'", top: 10, orderby: "invoiceDate desc" });
  return { content: [{ type: "text", text: JSON.stringify({ customer: c[0], invoices: inv }, null, 2) }] };
});

server.tool("bc_sales_summary", "Sales summary", {
  companyId: z.string(), top: z.number().optional().default(20)
}, async function(p) {
  var inv = await bcGet("companies(" + p.companyId + ")/salesInvoices", { top: p.top, orderby: "invoiceDate desc", select: "number,invoiceDate,customerName,totalAmountIncludingTax,status,remainingAmount" });
  var total = 0; var pending = 0;
  inv.forEach(function(i) { total += i.totalAmountIncludingTax || 0; pending += i.remainingAmount || 0; });
  return { content: [{ type: "text", text: JSON.stringify({ count: inv.length, totalSales: total, totalPending: pending, recent: inv.slice(0, 5) }, null, 2) }] };
});

server.tool("bc_create", "Create record in BC", {
  companyId: z.string(), entity: z.string(), data: z.string().describe("JSON record data")
}, async function(p) {
  var r = await bcWrite("POST", "companies(" + p.companyId + ")/" + p.entity, JSON.parse(p.data));
  return { content: [{ type: "text", text: "Created:\n" + JSON.stringify(r, null, 2) }] };
});

server.tool("bc_update", "Update record in BC", {
  companyId: z.string(), entity: z.string(), entityId: z.string(), etag: z.string(), data: z.string()
}, async function(p) {
  var r = await bcWrite("PATCH", "companies(" + p.companyId + ")/" + p.entity + "(" + p.entityId + ")", JSON.parse(p.data), p.etag);
  return { content: [{ type: "text", text: "Updated:\n" + JSON.stringify(r, null, 2) }] };
});

server.tool("bc_custom", "Query custom BC APIs", {
  url: z.string(), top: z.number().optional().default(20), filter: z.string().optional()
}, async function(p) {
  var full = p.url.indexOf("http") === 0 ? p.url : apiBase() + "/" + p.url;
  var qp = []; if (p.top) qp.push("$top=" + p.top); if (p.filter) qp.push("$filter=" + encodeURIComponent(p.filter));
  if (qp.length) full += "?" + qp.join("&");
  var tk = await getToken();
  var res = await fetch(full, { headers: { Authorization: "Bearer " + tk, Accept: "application/json" } });
  if (!res.ok) throw new Error("BC " + res.status + ": " + (await res.text()).substring(0, 500));
  var d = await res.json(); var records = d.value || d;
  return { content: [{ type: "text", text: (Array.isArray(records) ? records.length : 1) + " records:\n" + JSON.stringify(records, null, 2) }] };
});

// ===== Express with Streamable HTTP Transport =====
var app = express();
app.use(express.json());

// Store transports by session
var transports = {};

// Handle MCP requests (POST /mcp)
app.post("/mcp", async function(req, res) {
  var sessionId = req.headers["mcp-session-id"];
  var transport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: function() { return randomUUID(); },
      onsessioninitialized: function(sid) {
        transports[sid] = transport;
        console.log("[MCP] Session created: " + sid);
      }
    });
    transport.onclose = function() {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log("[MCP] Session closed: " + transport.sessionId);
      }
    };
    await server.connect(transport);
  }

  await transport.handleRequest(req, res);
});

// Handle SSE (GET /mcp) for streaming responses
app.get("/mcp", async function(req, res) {
  var sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).json({ error: "No session. Send POST /mcp first." });
    return;
  }
  var transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

// Handle session cleanup (DELETE /mcp)
app.delete("/mcp", async function(req, res) {
  var sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports[sessionId]) {
    var transport = transports[sessionId];
    await transport.handleRequest(req, res);
    delete transports[sessionId];
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

// SSE transport for backward compatibility (imported at top)
var sseTransports = {};

app.get("/sse", async function(req, res) {
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  console.log("[SSE] New connection");
  var sseServer = new McpServer({ name: "business-central", version: "4.0.0" });
  // Re-register all tools on this new server instance for SSE
  // (SSE needs its own server instance)
  var transport = new SSEServerTransport("/messages", res);
  sseTransports[transport.sessionId] = transport;
  res.on("close", function() { delete sseTransports[transport.sessionId]; });
  await server.connect(transport);
});

app.post("/messages", express.json(), async function(req, res) {
  var t = sseTransports[req.query.sessionId];
  if (!t) return res.status(404).json({ error: "Session not found" });
  await t.handlePostMessage(req, res);
});

app.get("/health", function(req, res) {
  res.json({ status: "ok", version: "4.0.0", mode: "multi-tenant", connected: bc.connected });
});

app.get("/", function(req, res) {
  res.json({ name: "Business Central MCP Server", version: "4.0.0", endpoints: { mcp: "/mcp", sse: "/sse", health: "/health" } });
});

app.listen(PORT, "0.0.0.0", function() {
  console.log("BC MCP v4.0 on port " + PORT);
  console.log("Streamable HTTP: /mcp");
  console.log("SSE: /sse");
});
