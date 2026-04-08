import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import { randomUUID } from "crypto";

const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || "https://bc-mcp-server-production.up.railway.app";

// ── Auth helpers (stateless — credentials passed per call) ────────────────
var tokenCache = {};

async function getToken(tenant, clientId, clientSecret) {
  var cacheKey = tenant + "|" + clientId;
  var cached = tokenCache[cacheKey];
  if (cached && Date.now() < cached.expiry) return cached.token;

  var url = "https://login.microsoftonline.com/" + tenant + "/oauth2/v2.0/token";
  var body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://api.businesscentral.dynamics.com/.default"
  });
  var r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body
  });
  if (!r.ok) throw new Error("Auth error " + r.status + ": " + (await r.text()).substring(0, 200));
  var d = await r.json();
  tokenCache[cacheKey] = { token: d.access_token, expiry: Date.now() + (d.expires_in - 120) * 1000 };
  return tokenCache[cacheKey].token;
}

async function bcGet(tenant, environment, clientId, clientSecret, path, opts) {
  var tk = await getToken(tenant, clientId, clientSecret);
  var base = "https://api.businesscentral.dynamics.com/v2.0/" + tenant + "/" + environment + "/api/v2.0";
  var qs = [];
  if (opts && opts.top) qs.push("$top=" + opts.top);
  if (opts && opts.filter) qs.push("$filter=" + encodeURIComponent(opts.filter));
  if (opts && opts.select) qs.push("$select=" + opts.select);
  if (opts && opts.orderby) qs.push("$orderby=" + encodeURIComponent(opts.orderby));
  var url = base + path + (qs.length ? "?" + qs.join("&") : "");
  var r = await fetch(url, { headers: { Authorization: "Bearer " + tk, Accept: "application/json" } });
  if (!r.ok) throw new Error("BC API " + r.status + ": " + (await r.text()).substring(0, 300));
  var data = await r.json();
  return data.value !== undefined ? data.value : data;
}

// ── Shared credential schema ───────────────────────────────────────────────
var creds = {
  tenant: z.string().describe("Azure AD Tenant ID"),
  environment: z.string().describe("BC environment, e.g. 'Production' or 'Sandbox'"),
  clientId: z.string().describe("Azure App Client ID"),
  clientSecret: z.string().describe("Azure App Client Secret")
};

// ── Tool registration ─────────────────────────────────────────────────────
function registerTools(server) {

  server.tool("bc_test_connection", "Test credentials and list companies", creds,
    async function(p) {
      var data = await bcGet(p.tenant, p.environment, p.clientId, p.clientSecret, "/companies");
      var list = data.map(function(c) { return "• " + c.name + " (id: " + c.id + ")"; }).join("\n");
      return { content: [{ type: "text", text: "Connected! Companies:\n" + list }] };
    }
  );

  server.tool("bc_list_companies", "List all companies in BC", creds,
    async function(p) {
      var data = await bcGet(p.tenant, p.environment, p.clientId, p.clientSecret, "/companies");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool("bc_query", "Query any BC entity (customers, vendors, items, salesInvoices, etc.)", Object.assign({}, creds, {
    companyId: z.string().describe("Company GUID from bc_list_companies"),
    entity: z.string().describe("Entity: customers, vendors, items, salesInvoices, purchaseOrders, salesOrders, generalLedgerEntries, contacts, employees..."),
    top: z.number().optional().default(20),
    filter: z.string().optional().describe("OData filter e.g. \"displayName eq 'ACME'\""),
    select: z.string().optional().describe("Comma-separated fields"),
    orderby: z.string().optional()
  }), async function(p) {
    var data = await bcGet(p.tenant, p.environment, p.clientId, p.clientSecret,
      "/companies(" + p.companyId + ")/" + p.entity,
      { top: p.top, filter: p.filter, select: p.select, orderby: p.orderby }
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("bc_get_record", "Get a single record by ID", Object.assign({}, creds, {
    companyId: z.string(),
    entity: z.string(),
    recordId: z.string().describe("Record GUID")
  }), async function(p) {
    var data = await bcGet(p.tenant, p.environment, p.clientId, p.clientSecret,
      "/companies(" + p.companyId + ")/" + p.entity + "(" + p.recordId + ")"
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("bc_sales_summary", "Open sales invoices summary", Object.assign({}, creds, {
    companyId: z.string(),
    top: z.number().optional().default(20)
  }), async function(p) {
    var data = await bcGet(p.tenant, p.environment, p.clientId, p.clientSecret,
      "/companies(" + p.companyId + ")/salesInvoices",
      { top: p.top, filter: "status eq 'Open'", select: "number,customerName,totalAmountIncludingTax,dueDate,status" }
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("bc_inventory", "Items with inventory levels", Object.assign({}, creds, {
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

  server.tool("bc_customers", "List customers with balance info", Object.assign({}, creds, {
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

  server.tool("bc_vendors", "List vendors", Object.assign({}, creds, {
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
}

// ── Express ───────────────────────────────────────────────────────────────
var app = express();

app.use(function(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, Accept");
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
app.get("/.well-known/oauth-protected-resource/mcp", function(req, res) {
  res.json({ resource: SERVER_URL + "/mcp", authorization_servers: [] });
});
app.get("/.well-known/oauth-authorization-server", function(req, res) {
  res.status(404).json({ error: "No auth server" });
});

// Streamable HTTP (/mcp)
app.use("/mcp", express.json());
var httpSessions = {};

app.post("/mcp", async function(req, res) {
  var sessionId = req.headers["mcp-session-id"];
  var transport;
  if (sessionId && httpSessions[sessionId]) {
    transport = httpSessions[sessionId].transport;
    await transport.handleRequest(req, res, req.body);
    return;
  }
  sessionId = randomUUID();
  var srv = new McpServer({ name: "business-central", version: "7.0.0" });
  registerTools(srv);
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: function() { return sessionId; },
    onsessioninitialized: function(sid) {
      httpSessions[sid] = { transport: transport, server: srv };
    }
  });
  await srv.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async function(req, res) {
  var sid = req.headers["mcp-session-id"];
  if (!sid || !httpSessions[sid]) return res.status(400).json({ error: "No session. POST /mcp first." });
  await httpSessions[sid].transport.handleRequest(req, res);
});

app.delete("/mcp", async function(req, res) {
  var sid = req.headers["mcp-session-id"];
  if (sid && httpSessions[sid]) {
    await httpSessions[sid].transport.handleRequest(req, res);
    delete httpSessions[sid];
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

// SSE (/sse)
var sseTransports = {};

app.get("/sse", function(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  var srv = new McpServer({ name: "business-central", version: "7.0.0" });
  registerTools(srv);
  var transport = new SSEServerTransport("/messages", res);
  sseTransports[transport.sessionId] = transport;
  res.on("close", function() { delete sseTransports[transport.sessionId]; });
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
  res.json({ status: "ok", version: "7.0.0" });
});

app.get("/", function(req, res) {
  res.json({ name: "BC MCP Server", version: "7.0.0", endpoints: ["/mcp", "/sse", "/health"] });
});

app.use(function(req, res) {
  console.log("[404]", req.method, req.url);
  res.status(404).json({ error: "Not found", path: req.url });
});

app.listen(PORT, "0.0.0.0", function() {
  console.log("BC MCP v7.0 on port " + PORT);
});
