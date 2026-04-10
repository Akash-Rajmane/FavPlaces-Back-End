import os from "os";

const appPort = Number(process.env.PORT || 5000);

const prometheusConfig = {
  metricsEndpoint: "/metrics",
  liveHealthEndpoint: "/health/live",
  readinessEndpoint: "/health/ready",
  metricsPort: Number(process.env.METRICS_PORT || appPort),
  appPort,

  appName: "favplaces-server",
  appVersion: "1.0.0",
  environment: process.env.NODE_ENV || "development",
  logLevel:
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === "production" ? "info" : "debug"),
  slowRequestThresholdMs: Number(process.env.SLOW_REQUEST_THRESHOLD_MS || 1000),

  prometheusServer: {
    host: process.env.PROMETHEUS_HOST || "localhost",
    port: Number(process.env.PROMETHEUS_PORT || 9090),
    configPath: "/monitoring/prometheus/prometheus.yml",
  },

  grafanaServer: {
    host: process.env.GRAFANA_HOST || "localhost",
    port: Number(process.env.GRAFANA_PORT || 5001),
    username: process.env.GRAFANA_USERNAME || "admin",
    password: process.env.GRAFANA_PASSWORD || "admin",
  },

  lokiConfig: {
    enabled: process.env.LOKI_ENABLED !== "false",
    host: process.env.LOKI_HOST || "localhost",
    port: Number(process.env.LOKI_PORT || 3100),
    endpoint: "/loki/api/v1/push",
  },

  node: {
    hostname: os.hostname(),
    platform: os.platform(),
    nodeVersion: process.version,
    cpuCount: os.cpus().length,
  },
};

export default prometheusConfig;
