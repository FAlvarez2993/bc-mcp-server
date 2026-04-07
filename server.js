import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

const PORT = process.env.PORT || 3001;

// Global BC connection state
const bc = {
  connected: false,
  tenant: "",
  environment: "",
  clientId: "",
  clientSecret: "",
  scope: "https://api.businesscentral.dynamics.com/.default",
  token: null,
  tokenExpiry: 0
};

async function getToken() {
  if (!bc.connected) {
    throw new Error("Not connected to BC. Use bc_connect first.");
  }
  if (bc.token && Date.now() < bc.tokenExpiry) {
    return bc.token;
  }
  var tokenUrl = "https://login.microsoftonline.com/" + bc.tenant + "/oauth2/v2.0/token";
  var body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: bc.clientId,
    client_secret: bc.clientSecret,
    scope: bc.scope
  });
  var res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body
  });
  if (!res.ok) {
    var errText = await res.text();
    throw new Error("Auth error " + res.status + ": " + errText.substring(0, 300));
  }
  var data = await res.json();
  bc.token = data.access_token;
  bc.tokenExpiry = Date.now() + (data.expires_in - 120) * 1000;
  console.log("[AUTH] Token obtained, expires in " + data.expires_in + "s");
  return bc.token;
}

function getApiBase() {
  return "https://api.businesscentral.dynamics.com/v2.0/" + bc.tenant + "/" + bc.environment + "/api/v2.0";
}

async function bcGet(endpoint, options) {
  var tk = await getToken();
  var parts = [];
  if (options && options.top) parts.push("$top=" + options.top);
  if (options && options.filter) parts.push("$filter=" + encodeURIComponent(options.filter));
  if (options && options.select) parts.push("$select=" + options.select);
  if (options && options.orderby) parts.push("$orderby=" + encodeURIComponent(options.orderby));
  var qs = parts.length > 0 ? "?" + parts.join("&") : "";
  var url = getApiBase() + "/" + endpoint + qs;
  console.log("[BC] GET " + url);
  var res = await fetch(url, {
    headers: { "Authorization": "Bearer " + tk, "Accept": "application/json" }
  });
  if (!res.ok) {
    var errText = await res.text();
    throw new Error("BC error " + res.status + ": " + errText.substring(0, 500));
  }
  var data = await res.json();
  return data.value || data;
}

async function bcWrite(method, endpoint, payload, etag) {
  var tk = await getToken();
  var url = getApiBase() + "/" + endpoint;
  console.log("[BC] " + method + " " + url);
  var headers = {
    "Authorization": "Bearer " + tk,
    "Content-Type": "application/json",
    "Accept": "application/json"
  };
  if (etag) headers["If-Match"] = etag;
  var res = await fetch(url, {
    method: method,
    headers: headers,
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    var errText = await res.text();
    throw new Error("BC " + method + " error " + res.status + ": " + errText.substring(0, 500));
  }
  return res.json();
}

// ===== MCP Server =====
var server = new McpServer({
  name: "business-central",
  version: "3.0.0"
});

server.tool(
  "bc_connect",
  "Connect to any Business Central tenant. Required before using other tools. Credentials are used only for this session.",
  {
    tenant: z.string().describe("Azure AD Tenant ID (GUID)"),
    environment: z.string().describe("BC Environment name: Production, Sandbox, etc."),
    clientId: z.string().describe("Azure AD App Registration Client ID"),
    clientSecret: z.string().describe("Azure AD App Registration Client Secret")
  },
  async function(params) {
    bc.tenant = params.tenant;
    bc.environment = params.environment;
    bc.clientId = params.clientId;
    bc.clientSecret = params.clientSecret;
    bc.token = null;
    bc.tokenExpiry = 0;
    try {
      await getToken();
      bc.connected = true;
      return {
        content: [{ type: "text", text: "Connected to Business Central!\nTenant: " + params.tenant + "\nEnvironment: " + params.environment }]
      };
    } catch (err) {
      bc.connected = false;
      return {
        content: [{ type: "text", text: "Connection failed: " + err.message }]
      };
    }
  }
);

server.tool(
  "bc_status",
  "Check current connection status",
  {},
  async function() {
    if (!bc.connected) {
      return { content: [{ type: "text", text: "Not connected. Use bc_connect first." }] };
    }
    return {
      content: [{ type: "text", text: "Connected to: " + bc.tenant + " / " + bc.environment + "\nToken: " + (bc.token ? "Active" : "Expired") }]
    };
  }
);

server.tool(
  "bc_list_companies",
  "List all companies available in the connected Business Central tenant",
  {},
  async function() {
    var data = await bcGet("companies");
    var result = data.map(function(c) {
      return { id: c.id, name: c.name, displayName: c.displayName };
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "bc_query",
  "Query any Business Central entity: customers, vendors, items, salesInvoices, salesOrders, purchaseInvoices, purchaseOrders, accounts, generalLedgerEntries, employees, bankAccounts, companyInformation, agedAccountsReceivables, agedAccountsPayables, contacts, opportunities, dimensions, projects, etc.",
  {
    companyId: z.string().describe("Company ID (GUID). Use bc_list_companies to get it."),
    entity: z.string().describe("Entity name: customers, vendors, items, salesInvoices, etc."),
    top: z.number().optional().default(20).describe("Max records to return"),
    filter: z.string().optional().describe("OData filter: balanceDue gt 0, city eq 'Madrid'"),
    select: z.string().optional().describe("Fields to return: displayName,number,email"),
    orderby: z.string().optional().describe("Sort: balanceDue desc")
  },
  async function(params) {
    var data = await bcGet(
      "companies(" + params.companyId + ")/" + params.entity,
      { top: params.top, filter: params.filter, select: params.select, orderby: params.orderby }
    );
    return {
      content: [{ type: "text", text: params.entity + ": " + data.length + " records\n\n" + JSON.stringify(data, null, 2) }]
    };
  }
);

server.tool(
  "bc_customer_summary",
  "Get a complete financial summary of a customer including recent invoices and aging",
  {
    companyId: z.string().describe("Company ID"),
    customerNumber: z.string().describe("Customer number")
  },
  async function(params) {
    var base = "companies(" + params.companyId + ")";
    var customers = await bcGet(base + "/customers", { filter: "number eq '" + params.customerNumber + "'" });
    if (!customers.length) {
      return { content: [{ type: "text", text: "Customer " + params.customerNumber + " not found" }] };
    }
    var invoices = await bcGet(base + "/salesInvoices", {
      filter: "customerNumber eq '" + params.customerNumber + "'",
      top: 10,
      orderby: "invoiceDate desc"
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ customer: customers[0], recentInvoices: invoices }, null, 2) }]
    };
  }
);

server.tool(
  "bc_sales_summary",
  "Get a sales summary with recent invoices, totals, and top customers",
  {
    companyId: z.string().describe("Company ID"),
    top: z.number().optional().default(20)
  },
  async function(params) {
    var invoices = await bcGet(
      "companies(" + params.companyId + ")/salesInvoices",
      { top: params.top, orderby: "invoiceDate desc", select: "number,invoiceDate,customerName,totalAmountIncludingTax,status,remainingAmount" }
    );
    var totalSales = 0;
    var totalPending = 0;
    invoices.forEach(function(inv) {
      totalSales += inv.totalAmountIncludingTax || 0;
      totalPending += inv.remainingAmount || 0;
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ count: invoices.length, totalSales: totalSales, totalPending: totalPending, recent: invoices.slice(0, 5) }, null, 2) }]
    };
  }
);

server.tool(
  "bc_create",
  "Create a new record in Business Central (customer, item, order, invoice, etc.)",
  {
    companyId: z.string().describe("Company ID"),
    entity: z.string().describe("Entity: customers, items, salesOrders, etc."),
    data: z.string().describe("JSON string with the record data")
  },
  async function(params) {
    var result = await bcWrite("POST", "companies(" + params.companyId + ")/" + params.entity, JSON.parse(params.data));
    return { content: [{ type: "text", text: "Created:\n" + JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "bc_update",
  "Update an existing record in Business Central",
  {
    companyId: z.string().describe("Company ID"),
    entity: z.string().describe("Entity: customers, items, etc."),
    entityId: z.string().describe("Record ID (GUID)"),
    etag: z.string().describe("Record ETag (from bc_query)"),
    data: z.string().describe("JSON string with fields to update")
  },
  async function(params) {
    var result = await bcWrite(
      "PATCH",
      "companies(" + params.companyId + ")/" + params.entity + "(" + params.entityId + ")",
      JSON.parse(params.data),
      params.etag
    );
    return { content: [{ type: "text", text: "Updated:\n" + JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "bc_custom",
  "Query custom BC APIs (custom AL pages). Example: api/ESDEN/app1/v2.0/companies({id})/jobESDEN",
  {
    url: z.string().describe("Relative path from api/v2.0/ or full URL"),
    top: z.number().optional().default(20),
    filter: z.string().optional()
  },
  async function(params) {
    var fullUrl = params.url.indexOf("http") === 0 ? params.url : getApiBase() + "/" + params.url;
    var parts = [];
    if (params.top) parts.push("$top=" + params.top);
    if (params.filter) parts.push("$filter=" + encodeURIComponent(params.filter));
    if (parts.length > 0) fullUrl += "?" + parts.join("&");
    var tk = await getToken();
    var res = await fetch(fullUrl, {
      headers: { "Authorization": "Bearer " + tk, "Accept": "application/json" }
    });
    if (!res.ok) {
      var errText = await res.text();
      throw new Error("BC " + res.status + ": " + errText.substring(0, 500));
    }
    var data = await res.json();
    var records = data.value || data;
    var count = Array.isArray(records) ? records.length : 1;
    return {
      content: [{ type: "text", text: count + " records:\n" + JSON.stringify(records, null, 2) }]
    };
  }
);

// ===== Express + SSE Transport =====
var app = express();
var transports = {};

// Important: disable proxy buffering for SSE
app.use(function(req, res, next) {
  res.setHeader("X-Accel-Buffering", "no");
  next();
});

app.get("/sse", async function(req, res) {
  console.log("[MCP] New SSE connection from " + req.ip);
  var transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", function() {
    console.log("[MCP] SSE connection closed: " + transport.sessionId);
    delete transports[transport.sessionId];
  });
  await server.connect(transport);
});

app.post("/messages", express.json(), async function(req, res) {
  var sessionId = req.query.sessionId;
  var transport = transports[sessionId];
  if (!transport) {
    return res.status(404).json({ error: "Session not found" });
  }
  await transport.handlePostMessage(req, res);
});

app.get("/health", function(req, res) {
  res.json({
    status: "ok",
    version: "3.0.0",
    mode: "multi-tenant-dynamic",
    connected: bc.connected,
    tenant: bc.tenant ? bc.tenant.substring(0, 8) + "..." : "none",
    environment: bc.environment || "none",
    activeSessions: Object.keys(transports).length,
    tools: [
      "bc_connect", "bc_status", "bc_list_companies", "bc_query",
      "bc_customer_summary", "bc_sales_summary",
      "bc_create", "bc_update", "bc_custom"
    ]
  });
});

app.get("/", function(req, res) {
  res.json({
    name: "Business Central MCP Server",
    version: "3.0.0",
    description: "Connect Claude to any Microsoft Dynamics 365 Business Central tenant",
    sse_endpoint: "/sse",
    health_endpoint: "/health"
  });
});

app.listen(PORT, "0.0.0.0", function() {
  console.log("BC MCP Server v3.0 listening on port " + PORT);
  console.log("SSE endpoint: /sse");
  console.log("Health: /health");
});
