# Connect the Rastrata plugin to ChatGPT

The local plugin is implemented in `apps/mcp`, with the portable package under
`plugins/rastrata`. Connect its private MCP endpoint in ChatGPT developer mode
before distributing a complete installed plugin. This guide follows OpenAI's
[connection workflow](https://developers.openai.com/plugins/deploy/connect-chatgpt)
and [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## Start an isolated test book

Use a separate database and ports so the evaluation does not change the default
local book. Run from the repository root:

```sh
RASTRATA_LOCAL_DB="$PWD/apps/web/.local/chatgpt-demo.sqlite" RASTRATA_API_PORT=4011 bun run dev:api
```

In another terminal, start MCP with the grants needed for the evaluation:

```sh
RASTRATA_API_URL=http://127.0.0.1:4011 RASTRATA_MCP_PORT=4021 RASTRATA_MCP_PERMISSIONS=read,draft,post,configure,correct,close,provision bun run dev:mcp
```

`http://127.0.0.1:4021/health` should report the selected book and permissions.
It does not establish API readiness; `rastrata_get_book` checks the full connection.
The test book starts unconfigured. Setup requires explicit fiscal settings and a
chart, and cannot reset an already configured book.

## Create the private connection

1. Sign in to the intended ChatGPT account/workspace. Enable **Developer mode** in
   **Settings → Security and login**, subject to workspace policy. If the MCP app
   creation form is already available in your account, open it directly.
2. Create or select a tunnel in
   [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
   Platform has a separate sign-in session from ChatGPT.
   Associate it with the ChatGPT workspace that will use it. Managing tunnels and
   using them require the corresponding Platform organization permissions.
3. Install OpenAI's `tunnel-client` using the download link in tunnel settings or
   the [official release](https://github.com/openai/tunnel-client/releases/latest).
   Use `tunnel-client help quickstart` to configure an HTTP profile named `rastrata`
   for the selected tunnel, targeting `http://127.0.0.1:4021/mcp`. Create its runtime
   key in [Platform API keys](https://platform.openai.com/settings/organization/api-keys).
   Select **Restricted** permissions and grant only **Tunnels → Read + Use**, with
   other capabilities set to **None**. Set an expiration for the development key.
   Keep the key in the tunnel client's secret configuration, not in the plugin
   package.
   For the initial server without OAuth discovery, create the profile with:

   ```sh
   tunnel-client init --sample sample_mcp_remote_no_auth --profile rastrata \
     --tunnel-id YOUR_TUNNEL_ID --mcp-server-url http://127.0.0.1:4021/mcp \
     --health-listen-addr 127.0.0.1:0
   ```

   Replace `YOUR_TUNNEL_ID` with the real ID and supply the runtime key through
   `CONTROL_PLANE_API_KEY`. The profile stores an environment reference rather
   than the key. Do not paste the key into ChatGPT or commit it to the repository.
   A private file reference is also supported with
   `--control-plane-api-key-ref file:/absolute/path/to/key-file`; restrict that file
   to the local operator with permissions `0600`.
4. Verify and run the profile:

   ```sh
   tunnel-client doctor --profile rastrata --explain
   tunnel-client run --profile rastrata
   ```

5. At [ChatGPT Plugins](https://chatgpt.com/plugins), use **Add → Create MCP App**.
   Name the developer connection **Rastrata** and describe it as **Manual bookkeeping and
   accounting reports**. Choose **Tunnel** under **Connection** and select that
   tunnel. This initial private development server uses the fixed local operator,
   with **No authentication** selected in the form. The private tunnel controls
   access to this isolated demo server. Keep the connection within its intended
   workspace.
6. Create the connection and inspect the discovered tools. With all grants above,
   it exposes 26 tools: 24 application operations, a UUID utility and the bookkeeping
   guide. Keep the API, MCP server and tunnel client running while testing.

## Bind and test the package

Copy the connection's technical ID from its ChatGPT URL. OpenAI documents developer
connection IDs beginning with `plugin_asdk_app`. Build a package bound to that
actual ID, replacing `YOUR_REGISTERED_ID` below:

```sh
bun run --cwd apps/mcp package:plugin --out /tmp/rastrata-chatgpt-plugin --app-id YOUR_REGISTERED_ID
```

The output contains root `plugin.json`, `.app.json`, the bookkeeping skill and
`rastrata.zip`. The OpenAI manifest extension points to the registered connection;
this package does not also start a second local MCP connection.
Use the [OpenAI packaging workflow](https://developers.openai.com/plugins/build/plugins)
to install the complete package through a local source when needed.

Start a new ChatGPT conversation with Rastrata enabled. Run the
[evaluation inventory](../reference/chatgpt-plugin-evaluation.md), beginning with
read-only inspection and a draft-only journal. Check actual tool calls, arguments,
authorization behavior and the final accounting state.

After changing tool metadata or the skill, restart MCP, refresh the connection at
ChatGPT Plugins, and use a new conversation. Imported skills are snapshots, so a
changed file alone does not update an installed copy.

## Public distribution

The same plugin can later be submitted to the public directory. OpenAI requires a
stable public HTTPS MCP endpoint for submission; Secure MCP Tunnel supports private
developer connections rather than public distribution. That release also needs
production account authentication and book permissions, plus the directory's
publisher and review requirements. See
[OpenAI submission requirements](https://developers.openai.com/plugins/deploy/submission).
The initial local server is not that hosted release.
