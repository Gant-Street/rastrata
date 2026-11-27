import { readOwnerKey } from "@rastrata/application/agent/local";
import { BUSINESS_PERMISSIONS, type BusinessPermission } from "@rastrata/application/schema";
import { startLocalMcpServer } from "./server.ts";

if (process.env.RASTRATA_LOCAL_DEV !== "1")
  throw new Error("The initial MCP server requires explicit RASTRATA_LOCAL_DEV=1 local mode");
const port = process.env.RASTRATA_MCP_PORT ?? "4020";
if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  throw new Error("Invalid RASTRATA_MCP_PORT");
const permissions = (process.env.RASTRATA_MCP_PERMISSIONS ?? "read,draft").split(",");
if (
  !permissions.includes("read") ||
  permissions.some((item) => !BUSINESS_PERMISSIONS.includes(item as BusinessPermission))
)
  throw new Error(
    "RASTRATA_MCP_PERMISSIONS must include read and contain only supported business permissions",
  );
// Needed only when the API was started with RASTRATA_OWNER_KEY_FILE: connections that bring no
// token are then the operator's own and need the owner key to reach it.
const ownerKeyFile = process.env.RASTRATA_OWNER_KEY_FILE;
const runtime = await startLocalMcpServer({
  apiUrl: process.env.RASTRATA_API_URL ?? "http://127.0.0.1:4010",
  bookId: process.env.RASTRATA_BOOK_ID ?? "local-book",
  permissions: permissions as BusinessPermission[],
  port: Number(port),
  ...(ownerKeyFile ? { ownerKey: readOwnerKey(ownerKeyFile) } : {}),
});
console.info(`Rastrata local MCP: ${new URL("/mcp", runtime.server.url)}`);
console.info(`Granted permissions: ${permissions.join(", ")}`);
console.info(
  "A connection that sends 'Authorization: Bearer <agent token>' gets that token's permissions instead.",
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void runtime.stop().then(() => process.exit(0));
  });
