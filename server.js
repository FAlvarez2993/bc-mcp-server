import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import { randomUUID } from "crypto";

const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || "https://bc-mcp-server-production.up.railway.app";

// ── BC State ──────────────────────────────────────────────────────────────
const bc = {
  connected: false, tenant: "", environment: "",
  clientId: "", clientSecret: "",
  scope: "https://api.businesscentral.dynamics.com/.default",
  token: null, tokenExpiry: 0
};

async function getToken() {
  if (!bc.connected) throw new Error("Not connected. Use bc_connect first.");
  if (bc.token && Date.now() < bc.tokenExpiry) return bc.token;
  var url = "https://login.microsoftonline.com/" + bc.tenant + "/oauth2/v2.0/token";
  var body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: bc.clientId,
    client_secret: bc.clientSecret,
    scope: bc.scope
  });
  var r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error("Auth error " + r.status + ": " + (await r.text()).substring(0, 200));
  var d = await r.json();
  bc.token = d.access_token;
  bc.tokenExpiry = Date.now() + (d.expires_in - 120) * 1000;
  return bc.token;
}

function apiBase() {
  return "https://api.businesscentral.dynamics.com/v2.0/" + bc.tenant + "/" + bc.environment + "/api/v2.0";
}

async function bcGet(path, opts) {
  var tk = await getToken();
  var qs = [];
  if (opts && opts.top) qs.push("$top=" + opts.top);
  if (opts && opts.filter) qs.push("$filter=" + encodeURIComponent(opts.filter));
  if (opts && opts.select) qs.push("$select=" + opts.select);
  if (opts && opts.orderby) qs.push("$orderby=" + encodeURIComponent(opts.orderby));
  var url = apiBase() + path + (qs.length ? "?" + qs.join("&") : "");
  var r = await fetch(url, { headers: { Authorization: "Bearer " + tk, Accept: "application/json" } });
  if (!r.ok) throw new Error("BC API error " + r.status + ": " + (await r.text()).substring(0, 200));
  var data = await r.json();
  return data.value !== undefined ? data.value : data;
}

// ── Tool registration ─────────────────────────────────────────────────────
function registerTools(server) {
  server.tool("bc_connect", "Connect to Business Central", {
    tenant: z.string().describe("Azure AD Tenant ID"),
    environment: z.string().describe("BC environment name, e.g. 'Production' or 'Sandbox'"),
    clientId: z.string().describe("Azure App Registration Client ID"),
    clientSecret: z.string().describe("Azure App Registration Client Secret")
  }, async function(p) {
    bc.tenant = p.tenant; bc.environment = p.environment;
    bc.clientId = p.clientId; bc.clientSecret = p.clientSecret;
    bc.token = null; bc.tokenExpiry = 0;
    try {
      await getToken();
      bc.connected = true;
      return { content: [{ type: "text", text: "Connected to BC: " + p.environment + " (tenant: " + p.tenant.substring(0,8) + "...)" }] };
    } catch (e) {
      bc.connected = false;
      return { content: [{ type: "text", text: "Connection failed: " + e.message }] };
    }
  });

  server.tool("bc_list_companies", "List all companies in BC", {}, async function() {
    var data = await bcGet("/companies");
    var list = data.map(function(c) { return c.id + " | " + c.name; }).join("\n");
    return { content: [{ type: "text", text: list || "No companies found." }] };
  });

  server.tool("bc_query", "Query any BC entity", {
    companyId: z.string().describe("Company GUID from bc_list_companies"),
    entity: z.string().describe("Entity name: customers, vendors, items, salesInvoices, purchaseOrders, salesOrders, generalLedgerEntries, etc."),
    top: z.number().optional().default(20).describe("Max records to return"),
    filter: z.string().optional().describe("OData filter, e.g. \"displayName eq 'ACME'\""),
    select: z.string().optional().describe("Comma-separated fields to return")
  }, async function(p) {
    var data = await bcGet("/companies(" + p.companyId + ")/" + p.entity, {
      top: p.top, filter: p.filter, select: p.select
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("bc_get_record", "Get a single BC record by ID", {
    companyId: z.string(),
    entity: z.string().describe("Entity name, e.g. customers, items"),
    recordId: z.string().describe("Record GUID")
  }, async function(p) {
    var data = await bcGet("/companies(" + p.companyId + ")/" + p.entity + "(" + p.recordId + ")");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("bc_sales_summary", "Sales summary: top customers and open invoices", {
    companyId: z.string(),
    top: z.number().optional().default(10)
  }, async function(p) {
    var invoices = await bcGet("/companies(" + p.companyId + ")/salesInvoices", {
      top: p.top, filter: "status eq 'Open'", select: "number,customerName,totalAmountIncludingTax,dueDate,status"
    });
    return { content: [{ type: "text", text: JSON.stringify(invoices, null, 2) }] };
  });

  server.tool("bc_inventory", "Inventory: items with stock levels", {
    companyId: z.string(),
    top: z.number().optional().default(20),
    filter: z.string().optional()
  }, async function(p) {
    var items = await bcGet("/companies(" + p.companyId + ")/items", {
      top: p.top, filter: p.filter, select: "number,displayName,inventory,unitPrice,unitCost,type"
    });
    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  });
}

// ── Express App ───────────────────────────────────────────────────────────
var app = express();

app.use(function(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── OAuth Discovery (NEW — required by Claude.ai MCP 2025 spec) ───────────
// Tells Claude: "this server is public, no OAuth needed"
app.get("/.well-known/oauth-protected-resource", function(req, res) {
  res.json({
    resource: SERVER_URL,
    authorization_servers: []   // empty = no auth required
  });
});

app.get("/.well-known/oauth-protected-resource/sse", function(req, res) {
  res.json({
    resource: SERVER_URL + "/sse",
    authorization_servers: []
  });
});

app.get("/.well-known/oauth-authorization-server", function(req, res) {
  res.status(404).json({ error: "No authorization server configured" });
});

// ── Streamable HTTP transport (/mcp) ──────────────────────────────────────
app.use("/mcp", express.json());

var httpSessions = {};

app.post("/mcp", async function(req, res) {
  var sessionId = req.headers["mcp-session-id"];
  var transport;
  if (sessionId && httpSessions[sessionId]) {
    transport = httpSessions[sessionId];
  } else {
    sessionId = randomUUID();
    var srv = new McpServer({ name: "business-central", version: "6.0.0" });
    registerTools(srv);
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: function() { return sessionId; },
      onsessioninitialized: function(sid) { httpSessions[sid] = transport; }
    });
    await srv.connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async function(req, res) {
  var sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !httpSessions[sessionId]) {
    return res.status(400).json({ error: "No session. POST /mcp first." });
  }
  await httpSessions[sessionId].handleRequest(req, res);
});

app.delete("/mcp", async function(req, res) {
  var sessionId = req.headers["mcp-session-id"];
  if (sessionId && httpSessions[sessionId]) {
    await httpSessions[sessionId].handleRequest(req, res);
    delete httpSessions[sessionId];
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

// ── SSE transport (/sse) ──────────────────────────────────────────────────
var sseTransports = {};

app.get("/sse", function(req, res) {
  console.log("[SSE] New connection");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  var srv = new McpServer({ name: "business-central", version: "6.0.0" });
  registerTools(srv);
  var transport = new SSEServerTransport("/messages", res);
  sseTransports[transport.sessionId] = transport;

  res.on("close", function() { delete sseTransports[transport.sessionId]; });

  srv.connect(transport).catch(function(e) {
    console.error("[SSE] error:", e.message);
  });
});

app.post("/messages", express.json(), function(req, res) {
  var t = sseTransports[req.query.sessionId];
  if (!t) return res.status(400).json({ error: "Session not found" });
  t.handlePostMessage(req, res).catch(function(e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
});

// ── Health & Root ─────────────────────────────────────────────────────────
app.get("/health", function(req, res) {
  res.json({ status: "ok", version: "6.0.0", httpSessions: Object.keys(httpSessions).length, sseSessions: Object.keys(sseTransports).length });
});

app.get("/", function(req, res) {
  res.json({ name: "BC MCP Server", version: "6.0.0", endpoints: { mcp: "/mcp", sse: "/sse", health: "/health" } });
});

app.use(function(req, res) {
  console.log("[404]", req.method, req.url);
  res.status(404).json({ error: "Not found", path: req.url });
});

app.listen(PORT, "0.0.0.0", function() {
  console.log("BC MCP v6.0 on port " + PORT);
});
