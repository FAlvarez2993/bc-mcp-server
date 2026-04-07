import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

var PORT = process.env.PORT || 3001;

// === BC Connection State ===
var bc = { connected: false, tenant: "", environment: "", clientId: "", clientSecret: "", token: null, tokenExpiry: 0 };

async function getToken() {
  if (!bc.connected) throw new Error("Not connected. Use bc_connect first.");
  if (bc.token && Date.now() < bc.tokenExpiry) return bc.token;
  var r = await fetch("https://login.microsoftonline.com/" + bc.tenant + "/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: bc.clientId, client_secret: bc.clientSecret, scope: "https://api.businesscentral.dynamics.com/.default" })
  });
  if (!r.ok) throw new Error("Auth " + r.status);
  var d = await r.json();
  bc.token = d.access_token;
  bc.tokenExpiry = Date.now() + (d.expires_in - 120) * 1000;
  return bc.token;
}

function base() { return "https://api.businesscentral.dynamics.com/v2.0/" + bc.tenant + "/" + bc.environment + "/api/v2.0"; }

async function bcGet(ep, o) {
  var tk = await getToken(); var q = [];
  if (o && o.top) q.push("$top=" + o.top);
  if (o && o.filter) q.push("$filter=" + encodeURIComponent(o.filter));
  if (o && o.select) q.push("$select=" + o.select);
  if (o && o.orderby) q.push("$orderby=" + encodeURIComponent(o.orderby));
  var url = base() + "/" + ep + (q.length ? "?" + q.join("&") : "");
  var r = await fetch(url, { headers: { Authorization: "Bearer " + tk, Accept: "application/json" } });
  if (!r.ok) throw new Error("BC " + r.status + ": " + (await r.text()).substring(0, 300));
  var d = await r.json(); return d.value || d;
}

// === Register tools on a server instance ===
function registerTools(srv) {
  srv.tool("bc_connect", "Connect to any Business Central tenant", {
    tenant: z.string(), environment: z.string(), clientId: z.string(), clientSecret: z.string()
  }, async function(p) {
    bc.tenant = p.tenant; bc.environment = p.environment; bc.clientId = p.clientId; bc.clientSecret = p.clientSecret;
    bc.token = null; bc.tokenExpiry = 0;
    try { await getToken(); bc.connected = true; return { content: [{ type: "text", text: "Connected! Tenant: " + p.tenant + " Env: " + p.environment }] }; }
    catch (e) { bc.connected = false; return { content: [{ type: "text", text: "Error: " + e.message }] }; }
  });

  srv.tool("bc_status", "Connection status", {}, async function() {
    return { content: [{ type: "text", text: bc.connected ? "Connected: " + bc.tenant + "/" + bc.environment : "Not connected" }] };
  });

  srv.tool("bc_list_companies", "List companies", {}, async function() {
    var d = await bcGet("companies");
    return { content: [{ type: "text", text: JSON.stringify(d.map(function(c) { return { id: c.id, name: c.name }; }), null, 2) }] };
  });

  srv.tool("bc_query", "Query any BC entity", {
    companyId: z.string(), entity: z.string(),
    top: z.number().optional().default(20), filter: z.string().optional(),
    select: z.string().optional(), orderby: z.string().optional()
  }, async function(p) {
    var d = await bcGet("companies(" + p.companyId + ")/" + p.entity, { top: p.top, filter: p.filter, select: p.select, orderby: p.orderby });
    return { content: [{ type: "text", text: p.entity + ": " + d.length + " records\n" + JSON.stringify(d, null, 2) }] };
  });

  srv.tool("bc_customer_summary", "Customer financial summary", {
    companyId: z.string(), customerNumber: z.string()
  }, async function(p) {
    var c = await bcGet("companies(" + p.companyId + ")/customers", { filter: "number eq '" + p.customerNumber + "'" });
    if (!c.length) return { content: [{ type: "text", text: "Not found" }] };
    var inv = await bcGet("companies(" + p.companyId + ")/salesInvoices", { filter: "customerNumber eq '" + p.customerNumber + "'", top: 10, orderby: "invoiceDate desc" });
    return { content: [{ type: "text", text: JSON.stringify({ customer: c[0], invoices: inv }, null, 2) }] };
  });

  srv.tool("bc_create", "Create record", {
    companyId: z.string(), entity: z.string(), data: z.string()
  }, async function(p) {
    var tk = await getToken();
    var r = await fetch(base() + "/companies(" + p.companyId + ")/" + p.entity, {
      method: "POST", headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json", Accept: "application/json" },
      body: p.data
    });
    if (!r.ok) throw new Error("BC " + r.status);
    return { content: [{ type: "text", text: "Created: " + JSON.stringify(await r.json(), null, 2) }] };
  });

  srv.tool("bc_custom", "Query custom APIs", {
    url: z.string(), top: z.number().optional().default(20), filter: z.string().optional()
  }, async function(p) {
    var full = p.url.indexOf("http") === 0 ? p.url : base() + "/" + p.url;
    var q = []; if (p.top) q.push("$top=" + p.top); if (p.filter) q.push("$filter=" + encodeURIComponent(p.filter));
    if (q.length) full += "?" + q.join("&");
    var tk = await getToken();
    var r = await fetch(full, { headers: { Authorization: "Bearer " + tk, Accept: "application/json" } });
    if (!r.ok) throw new Error("BC " + r.status);
    var d = await r.json(); var rec = d.value || d;
    return { content: [{ type: "text", text: JSON.stringify(rec, null, 2) }] };
  });
}

// === Express App ===
var app = express();
app.use(express.json());

// Store active transports
var transports = {};

// SSE endpoint - each connection gets its OWN McpServer instance
app.get("/sse", function(req, res) {
  console.log("[SSE] New connection");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  try {
    var srv = new McpServer({ name: "business-central", version: "5.0.0" });
    registerTools(srv);
    var transport = new SSEServerTransport("/messages", res);
    transports[transport.sessionId] = transport;
    console.log("[SSE] Session: " + transport.sessionId);

    res.on("close", function() {
      console.log("[SSE] Closed: " + transport.sessionId);
      delete transports[transport.sessionId];
    });

    srv.connect(transport).catch(function(err) {
      console.error("[SSE] Connect error: " + err.message);
    });
  } catch (err) {
    console.error("[SSE] Error: " + err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Messages endpoint
app.post("/messages", function(req, res) {
  var sid = req.query.sessionId;
  console.log("[MSG] sessionId=" + sid);
  var transport = transports[sid];
  if (!transport) {
    console.log("[MSG] Session not found");
    return res.status(400).json({ error: "Session not found. Connect to /sse first." });
  }
  transport.handlePostMessage(req, res).catch(function(err) {
    console.error("[MSG] Error: " + err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
});

// Health
app.get("/health", function(req, res) {
  res.json({ status: "ok", version: "5.0.0", sessions: Object.keys(transports).length, connected: bc.connected });
});

// Root
app.get("/", function(req, res) {
  res.json({ name: "Business Central MCP Server", version: "5.0.0", sse: "/sse", health: "/health" });
});

// Catch-all for debugging
app.use(function(req, res) {
  console.log("[404] " + req.method + " " + req.url);
  res.status(404).json({ error: "Not found", path: req.url, method: req.method });
});

app.listen(PORT, "0.0.0.0", function() {
  console.log("BC MCP v5.0 on port " + PORT);
});
