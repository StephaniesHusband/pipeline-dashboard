const express = require("express");
const axios = require("axios");
const cors = require("cors");
const https = require("https");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const httpsAgent = new https.Agent({ rejectUnauthorized: process.env.IGNORE_SSL_ERRORS !== "true" });
const defaultJenkinsUrl = String(process.env.JENKINS_BASE_URL || "").trim().replace(/\/+$/, "");
const udeployBaseUrl = String(process.env.UDEPLOY_BASE_URL || "https://udeploy-wtc.prod.cloud.fedex.com:6371").trim().replace(/\/+$/, "");

function loadAuthStore() {
  try {
    const p = path.join(__dirname, "auth_store.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error("Error reading auth_store.json:", e.message);
  }
  return {};
}

function saveAuthStore(data) {
  try {
    const p = path.join(__dirname, "auth_store.json");
    fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("Error saving auth_store.json:", e.message);
  }
}

function loadApps() {
  try {
    const p = path.join(__dirname, "apps.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error("Error reading apps.json:", e.message);
  }
  return [];
}

function normalizeCookie(raw) {
  if (!raw) return "";
  let cleaned = String(raw).trim();
  cleaned = cleaned.replace(/^cookie:\s*/i, "");
  if (cleaned.includes("=")) {
    return cleaned.endsWith(";") ? cleaned : (cleaned + ";");
  }
  return "JSESSIONID=" + cleaned + ";";
}

function getAppAuth(appId) {
  const store = loadAuthStore();
  if (store[appId]) return store[appId];
  return {
    cookie: String(process.env.JENKINS_COOKIE || "").trim(),
    user: String(process.env.JENKINS_USER || "263952").trim(),
    token: String(process.env.JENKINS_API_TOKEN || "").trim()
  };
}

function getJobPath(raw) {
  if (!raw) return "";
  const segments = raw.split("/").filter(function(p) { return Boolean(p) && p !== "job"; });
  return "/job/" + segments.map(encodeURIComponent).join("/job/");
}

async function getJenkinsStatus(appConfig) {
  const jenkinsRoot = String(appConfig.jenkinsBaseUrl || defaultJenkinsUrl).trim().replace(/\/+$/, "");
  const jobBase = getJobPath(appConfig.jenkinsJob);
  const targetUrl = jenkinsRoot + jobBase + "/api/json";
  const auth = getAppAuth(appConfig.id);

  const headers = { Accept: "application/json" };
  let axiosAuth = undefined;
  const usingCookie = Boolean(auth.cookie);

  if (usingCookie) {
    headers["Cookie"] = normalizeCookie(auth.cookie);
  } else if (auth.user && auth.token) {
    axiosAuth = { username: auth.user, password: auth.token };
  }

  const client = axios.create({
    baseURL: jenkinsRoot,
    auth: axiosAuth,
    headers: headers,
    httpsAgent: httpsAgent,
    timeout: 12000
  });

  try {
    const response = await client.get(jobBase + "/api/json");
    const job = response.data;
    const last = job.lastBuild;
    const lastSuccessful = job.lastSuccessfulBuild;

    if (!last) {
      return {
        app: appConfig,
        success: true,
        isBuilding: false,
        inQueue: Boolean(job.inQueue),
        result: "NO_BUILDS",
        buildNumber: null,
        lastSuccessfulBuild: lastSuccessful ? lastSuccessful.number : null,
        buildUrl: jenkinsRoot + jobBase,
        detectedTargetEnv: null,
        allParams: [],
        authMode: usingCookie ? "Browser Session" : (axiosAuth ? "API Token" : "None"),
        urlAttempted: targetUrl,
        udeployUrl: udeployBaseUrl + "/#application/" + encodeURIComponent(appConfig.udeployApp || "")
      };
    }

    let details = last;
    try {
      const res = await client.get(jobBase + "/" + last.number + "/api/json");
      details = res.data || last;
    } catch (e) {}

    let targetEnv = null;
    let allParams = [];
    if (Array.isArray(details.actions)) {
      details.actions.forEach(function(a) {
        if (Array.isArray(a.parameters)) {
          a.parameters.forEach(function(p) {
            const pName = String(p.name || "");
            const pVal = String(p.value || "");
            allParams.push(pName + "=" + pVal);
            const name = pName.toUpperCase();
            const val = pVal.toUpperCase();
            if (name.includes("ENV") || name.includes("LEVEL") || name.includes("TARGET") || name.includes("TIER") || name.includes("DEPLOY")) {
              if (val === "L4" || val === "LP" || val.includes("L4") || val.includes("LP")) {
                targetEnv = val.includes("L4") ? "L4" : "LP";
              }
            }
          });
        }
      });
    }

    return {
      app: appConfig,
      success: true,
      isBuilding: Boolean(details.building),
      inQueue: Boolean(job.inQueue),
      buildNumber: details.number,
      lastSuccessfulBuild: lastSuccessful ? lastSuccessful.number : null,
      result: details.result || (details.building ? "IN_PROGRESS" : "UNKNOWN"),
      buildUrl: details.url || (jenkinsRoot + jobBase + "/" + details.number),
      detectedTargetEnv: targetEnv,
      allParams: allParams,
      authMode: usingCookie ? "Browser Session" : (axiosAuth ? "API Token" : "None"),
      urlAttempted: targetUrl,
      udeployUrl: udeployBaseUrl + "/#application/" + encodeURIComponent(appConfig.udeployApp || "")
    };
  } catch (err) {
    const status = err.response ? err.response.status : null;
    let errorMsg = (err.response && err.response.data && err.response.data.message) || err.message;
    let diagnosis = null;
    if (status === 401) {
      errorMsg = "Unauthorized (HTTP 401)";
      diagnosis = usingCookie ? "Session cookie expired or rejected for " + jenkinsRoot + ". Paste fresh Cookie header in Auth Settings." : "Authentication failed. Provide active browser session cookie in Auth Settings.";
    } else if (status === 404) {
      errorMsg = "Job Not Found (HTTP 404)";
      diagnosis = "Verify job path and jenkinsBaseUrl for this app. Quoted host: " + jenkinsRoot;
    }
    return {
      app: appConfig,
      success: false,
      statusCode: status,
      error: errorMsg,
      diagnosis: diagnosis,
      urlAttempted: targetUrl,
      authMode: usingCookie ? "Browser Session" : (axiosAuth ? "API Token" : "None"),
      udeployUrl: udeployBaseUrl + "/#application/" + encodeURIComponent(appConfig.udeployApp || "")
    };
  }
}

app.get("/api/apps", function(req, res) { res.json(loadApps()); });

app.get("/api/status-all", async function(req, res) {
  const apps = loadApps();
  const list = await Promise.all(apps.map(function(appItem) {
    return getJenkinsStatus(appItem);
  }));
  res.json({ pipelines: list, polledAt: new Date().toLocaleTimeString() });
});

app.get("/api/app-auth", function(req, res) {
  const appId = req.query.appId;
  const auth = getAppAuth(appId);
  res.json({ appId: appId, cookie: auth.cookie || "", user: auth.user || "263952", hasToken: Boolean(auth.token) });
});

app.post("/api/save-auth", function(req, res) {
  const body = req.body || {};
  const appId = body.appId;
  if (!appId) return res.status(400).json({ error: "appId is required" });
  const store = loadAuthStore();
  store[appId] = {
    cookie: String(body.cookie || "").trim(),
    user: String(body.user || "").trim(),
    token: String(body.token || "").trim()
  };
  saveAuthStore(store);
  res.json({ success: true, appId: appId });
});

app.listen(PORT, function() { console.log("Dashboard active on http://localhost:" + PORT); });
