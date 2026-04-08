import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

var PORT = process.env.PORT || 3001;
var bc = { connected: false, tenant: "", environment: "", clientId: "", clientSecret: "", token: null, tokenExpiry: 0 };

async function getToken() {
  if (!bc.connected) throw new Error("Not connected. Use bc_connect first.");
  if (bc.token && Date.now() < bc.tokenExpiry) return bc.token;
  var r = await fetch("https://login.microsoftonline.com/" + bc.tenant + "/oauth2/v2.0/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: bc.clientId, client_secret: bc.clientSecret, scope: "https://api.businesscentral.dynamics.com/.default" })
  });
  if (!r.ok) throw new Error("Auth " + r.status);
  var d = await r.json(); bc.token = d.access_token; bc.tokenExpiry = Date.now() + (d.expires_in - 120) * 1000; return bc.token;
}

function apiUrl() { return "https://api.businesscentral.dynamics.com/v2.0/" + bc.tenant + "/" + bc.environment + "/api/v2.0"; }

async function bcGet(ep, o) {
  var tk = await getToken(); var q = [];
  if (o && o.top) q.push("$top=" + o.top); if (o && o.filter) q.push("$filter=" + encodeURIComponent(o.filter));
  if (o && o.select) q.push("$select=" + o.select); if (o && o.orderby) q.push("$orderby=" + encodeURIComponent(o.orderby));
  var r = await fetch(apiUrl() + "/" + ep + (q.length ? "?" + q.join("&") : ""), { headers: { Authorization: "Bearer " + tk, Accept: "application/json" } });
  if (!r.ok) throw new Error("BC " + r.status + ": " + (await r.text()).substring(0, 300));
  var d = await r.json(); return d.value || d;
}

function addTools(srv) {
  srv.tool("bc_connect", "Connect to any Business Central tenant", { tenant: z.string(), environment: z.string(), clientId: z.string(), clientSecret: z.string() }, async function(p) {
    bc.tenant = p.tenant; bc.environment = p.environment; bc.clientId = p.clientId; bc.clientSecret = p.clientSecret; bc.token = null; bc.tokenExpiry = 0;
    try { await getToken(); bc.connected = true; return { content: [{ type: "text", text: "Connected! " + p.tenant + " / " + p.environment }] }; }
    catch (e) { bc.connected = false; return { content: [{ type: "text", text: "Error: " + e.message }] }; }
  });
  srv.tool("bc_list_companies", "List companies in BC", {}, async function() {
    var d = await bcGet("companies"); return { content: [{ type: "text", text: JSON.stringify(d.map(function(c){return{id:c.id,name:c.name}}), null, 2) }] };
  });
  srv.tool("bc_query", "Query any BC entity", { companyId: z.string(), entity: z.string(), top: z.number().optional().default(20), filter: z.string().optional(), select: z.string().optional(), orderby: z.string().optional() }, async function(p) {
    var d = await bcGet("companies(" + p.companyId + ")/" + p.entity, { top: p.top, filter: p.filter, select: p.select, orderby: p.orderby });
    return { content: [{ type: "text", text: p.entity + ": " + d.length + " records\n" + JSON.stringify(d, null, 2) }] };
  });
  srv.tool("bc_customer_summary", "Customer summary with invoices", { companyId: z.string(), customerNumber: z.string() }, async function(p) {
    var c = await bcGet("companies(" + p.companyId + ")/customers", { filter: "number eq '" + p.customerNumber + "'" });
    if (!c.length) return { content: [{ type: "text", text: "Not found" }] };
    var inv = await bcGet("companies(" + p.companyId + ")/salesInvoices", { filter: "customerNumber eq '" + p.customerNumber + "'", top: 10, orderby: "invoiceDate desc" });
    return { content: [{ type: "text", text: JSON.stringify({ customer: c[0], invoices: inv }, null, 2) }] };
  });
  srv.tool("bc_create", "Create record in BC", { companyId: z.string(), entity: z.string(), data: z.string() }, async function(p) {
    var tk = await getToken();
    var r = await fetch(apiUrl() + "/companies(" + p.companyId + ")/" + p.entity, { method: "POST", headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json", Accept: "application/json" }, body: p.data });
    if (!r.ok) throw new Error("BC " + r.status); return { content: [{ type: "text", text: "Created: " + JSON.stringify(await r.json(), null, 2) }] };
  });
  srv.tool("bc_custom", "Query custom BC APIs", { url: z.string(), top: z.number().optional().default(20), filter: z.string().optional() }, async function(p) {
    var full = p.url.indexOf("http") === 0 ? p.url : apiUrl() + "/" + p.url;
    var q = []; if (p.top) q.push("$top=" + p.top); if (p.filter) q.push("$filter=" + encodeURIComponent(p.filter));
    if (q.length) full += "?" + q.join("&");
    var tk = await getToken();
    var r = await fetch(full, { headers: { Authorization: "Bearer " + tk, Accept: "application/json" } });
    if (!r.ok) throw new Error("BC " + r.status);
    var d = await r.json(); return { content: [{ type: "text", text: JSON.stringify(d.value || d, null, 2) }] };
  });
}

// === Express ===
var app = express();
app.use(express.json());
var transports = {};

// Try to load StreamableHTTPServerTransport (new protocol)
var StreamableHTTPServerTransport = null;
try {
  var mod = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  StreamableHTTPServerTransport = mod.StreamableHTTPServerTransport;
  console.log("[INIT] StreamableHTTP transport available");
} catch (e) {
  console.log("[INIT] StreamableHTTP not available, using SSE only");
}

// === STREAMABLE HTTP on /sse (handles POST + GET + DELETE) ===
if (StreamableHTTPServerTransport) {
  app.post("/sse", async function(req, res) {
    console.log("[POST /sse] New request");
    var sessionId = req.headers["mcp-session-id"];
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res);
      return;
    }
    // New session
    var srv = new McpServer({ name: "business-central", version: "6.0.0" });
    addTools(srv);
    try {
      var transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined // let SDK generate
      });
      transport.onclose = function() {
        if (transport.sessionId) { delete transports[transport.sessionId]; }
      };
      await srv.connect(transport);
      transports[transport.sessionId] = transport;
      console.log("[POST /sse] Session: " + transport.sessionId);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[POST /sse] Error: " + err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  app.get("/sse", async function(req, res) {
    var sessionId = req.headers["mcp-session-id"];
    if (sessionId && transports[sessionId]) {
      console.log("[GET /sse] Streaming for " + sessionId);
      res.setHeader("X-Accel-Buffering", "no");
      await transports[sessionId].handleRequest(req, res);
    } else {
      res.status(400).json({ error: "No session. POST first." });
    }
  });

  app.delete("/sse", async function(req, res) {
    var sessionId = req.headers["mcp-session-id"];
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res);
      delete transports[sessionId];
    } else {
      res.status(404).json({ error: "Session not found" });
    }
  });
} else {
  // Fallback: SSE transport (old protocol)
  app.get("/sse", function(req, res) {
    console.log("[GET /sse] SSE fallback");
    res.setHeader("X-Accel-Buffering", "no");
    var srv = new McpServer({ name: "business-central", version: "6.0.0" });
    addTools(srv);
    var transport = new SSEServerTransport("/messages", res);
    transports[transport.sessionId] = transport;
    res.on("close", function() { delete transports[transport.sessionId]; });
    srv.connect(transport).catch(function(e) { console.error("[SSE] " + e.message); });
  });

  app.post("/messages", function(req, res) {
    var t = transports[req.query.sessionId];
    if (!t) return res.status(400).json({ error: "No session" });
    t.handlePostMessage(req, res).catch(function(e) { console.error("[MSG] " + e.message); });
  });
}

// OAuth discovery endpoints (Claude checks these)
app.get("/.well-known/oauth-protected-resource", function(req, res) { res.status(404).json({}); });
app.get("/.well-known/oauth-protected-resource/sse", function(req, res) { res.status(404).json({}); });
app.get("/.well-known/oauth-authorization-server", function(req, res) { res.status(404).json({}); });
app.post("/register", function(req, res) { res.status(404).json({}); });

app.get("/health", function(req, res) { res.json({ status: "ok", version: "6.0.0", sessions: Object.keys(transports).length, streamable: !!StreamableHTTPServerTransport }); });
app.get("/", function(req, res) { res.json({ name: "Business Central MCP", version: "6.0.0" }); });

app.listen(PORT, "0.0.0.0", function() { console.log("BC MCP v6.0 on port " + PORT + " (streamable=" + !!StreamableHTTPServerTransport + ")"); });
