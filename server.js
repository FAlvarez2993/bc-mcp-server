import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || "https://bc-mcp-server-production.up.railway.app";

// ── Token cache (stateless — credentials per call) ────────────────────────
var tokenCache = {};

async function getToken(tenant, clientId, clientSecret) {
  var key = tenant + "|" + clientId;
  var c = tokenCache[key];
  if (c && Date.now() < c.expiry) return c.token;
  var r = await fetch("https://login.microsoftonline.com/" + tenant + "/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://api.businesscentral.dynamics.com/.default"
    })
  });
  if (!r.ok) throw new Error("Auth error " + r.status + ": " + (await r.text()).substring(0, 200));
  var d = await r.json();
  tokenCache[key] = { token: d.access_token, expiry: Date.now() + (d.expires_in - 120) * 1000 };
  return tokenCache[key].token;
}

async function bcGet(tenant, env, clientId, clientSecret, path, opts) {
  var tk = await getToken(tenant, clientId, clientSecret);
  var qs = [];
  if (opts) {
    if (opts.top) qs.push("$top=" + opts.top);
    if (opts.filter) qs.push("$filter=" + encodeURIComponent(opts.filter));
    if (opts.select) qs.push("$select=" + opts.select);
    if (opts.orderby) qs.push("$orderby=" + encodeURIComponent(opts.orderby));
  }
  var url = "https://api.businesscentral.dynamics.com/v2.0/" + tenant + "/" + env + "/api/v2.0" + path + (qs.length ? "?" + qs.join("&") : "");
  var r = await fetch(url, { headers: { Authorization: "Bearer " + tk, Accept: "application/json" } });
  if (!r.ok) throw new Error("BC API " + r.status + ": " + (await r.text()).substring(0, 300));
  var d = await r.json();
  return d.value !== undefined ? d.value : d;
}

// ── Credential schema (included in every tool) ────────────────────────────
var C = {
  tenant: z.string().describe("Azure AD Tenant ID"),
  environment: z.string().describe("BC environment: 'Production' or 'Sandbox'"),
  clientId: z.string().describe("Azure App Client ID"),
  clientSecret: z.string().describe("Azure App Client Secret")
};

// ── Tools ─────────────────────────────────────────────────────────────────
function registerTools(srv) {

  srv.tool("bc_test_connection", "Test BC credentials and list companies", C, async function(p) {
    var data = await bcGet(p.tenant, p.environment, p.clientId, p.clientSecret, "/companies");
    var list = data.map(function(c) { return "• " + c.name + " (id: " + c.id + ")"; }).join("\n");
    return { content: [{ type: "text", text: "✅ Connected!\n\nCompanies:\n" + list }] };
  });

  srv.tool("bc_list_companies", "List all companies", C, async function(p) {
    var data = await bcGet(p.tenant, p.environment, p.clientId, p.clientSecret, "/companies");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  srv.tool("bc_query", "Query any BC entity", Object.assign({}, C, {
    companyId: z.string().describe("Company GUID"),
    entity: z.string().describe("Entity: customers, vendors, items, salesInvoices, purchaseOrders, salesOrders, generalLedgerEntries, contacts, employees..."),
    top: z.number().optional().default(20),
    filter: z.string().optional(),
    select: z.string().optional(),
    orderby: z.string().optional()
  }), async function(p) {
    var data = await bcGet(p.tenant, p.environment, p.clientId, p.clientSecret,
      "/companies(" + p.companyId + ")/" + p.entity,
      { top: p.top, filter: p.filter, select: p.select, orderby: p.orderby }
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  srv.tool("bc_get_record", "Get a single record by ID", Object.assign({}, C, {
    companyId: z.string(),
    entity: z.string(),
    recordId: z.string()
  }), async function(p) {
    var data = await bcGet(p.tenant, p.environment, p.clientId, p.clientSecret,
      "/companies(" + p.companyId + ")/" + p.entity + "(" + p.recordId + ")"
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  srv.tool("bc_customers", "List customers with balance info", Object.assign({}, C, {
    companyId: z.string(),
    top: z.number().optional().default(20),
    filter: z.string().optional()
  }), async function(p) {
    var data = await bcGet(p.tenant, p.environment, p.clientId, p.clientSecret,
      "/companies(" + p.companyId + ")/customers",
      { top: p.top, filter: p.filter, select: "number,displayName,email,phoneNumber,balance,creditLimit,blocked" }
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  srv.tool("bc_vendors", "List vendors", Object.assign({}, C, {
    companyId: z.string(),
    top: z.number().optional().default(20),
    filter: z.string().optional()
  }), async function(p) {
    var data = await bcGet(p.tenant, p.environment, p.clientId, p.clientSecret,
      "/companies(" + p.companyId + ")/vendors",
      { top: p.top, filter: p.filter, select: "number,displayName,email,phoneNumber,balance,blocked" }
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  srv.tool("bc_sales_invoices", "List sales invoices", Object.assign({}, C, {
    companyId: z.string(),
    top: z.number().optional().default(20),
    filter: z.string().optional().describe("e.g. \"status eq 'Open'\"")
  }), async function(p) {
    var data = await bcGet(p.tenant, p.environment, p.clientId, p.clientSecret,
      "/companies(" + p.companyId + ")/salesInvoices",
      { top: p.top, filter: p.filter, select: "number,customerName,totalAmountIncludingTax,dueDate,status,invoiceDate" }
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  srv.tool("bc_inventory", "Items with inventory levels", Object.assign({}, C, {
    companyId: z.string(),
    top: z.number().optional().default(30),
    filter: z.string().optional()
  }), async function(p) {
    var data = await bcGet(p.tenant, p.environment, p.clientId, p.clientSecret,
      "/companies(" + p.companyId + ")/items",
      { top: p.top, filter: p.filter, select: "number,displayName,inventory,unitPrice,unitCost,type" }
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });
}

// ── Express ───────────────────────────────────────────────────────────────
var app = express();

app.use(function(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// OAuth discovery — tells Claude "no auth required"
app.get("/.well-known/oauth-protected-resource", function(req, res) {
  res.json({ resource: SERVER_URL, authorization_servers: [] });
});
app.get("/.well-known/oauth-protected-resource/sse", function(req, res) {
  res.json({ resource: SERVER_URL + "/sse", authorization_servers: [] });
});
app.get("/.well-known/oauth-authorization-server", function(req, res) {
  res.status(404).json({ error: "No auth server" });
});

// SSE
var sseTransports = {};

app.get("/sse", function(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  console.log("[SSE] New connection");
  var srv = new McpServer({ name: "business-central", version: "7.1.0" });
  registerTools(srv);
  var transport = new SSEServerTransport("/messages", res);
  sseTransports[transport.sessionId] = transport;
  res.on("close", function() {
    console.log("[SSE] Disconnected:", transport.sessionId);
    delete sseTransports[transport.sessionId];
  });
  srv.connect(transport).catch(function(e) { console.error("[SSE]", e.message); });
});

app.post("/messages", express.json(), function(req, res) {
  var t = sseTransports[req.query.sessionId];
  if (!t) return res.status(400).json({ error: "Session not found" });
  t.handlePostMessage(req, res).catch(function(e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
});

app.get("/health", function(req, res) {
  res.json({ status: "ok", version: "7.1.0", sessions: Object.keys(sseTransports).length });
});

app.get("/", function(req, res) {
  res.json({ name: "BC MCP Server", version: "7.1.0", endpoint: "/sse" });
});

app.use(function(req, res) {
  console.log("[404]", req.method, req.url);
  res.status(404).json({ error: "Not found", path: req.url });
});

app.listen(PORT, "0.0.0.0", function() {
  console.log("BC MCP v7.1 on port " + PORT);
});
