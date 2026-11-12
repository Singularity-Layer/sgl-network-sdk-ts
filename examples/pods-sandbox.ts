/**
 * Agent Pods sandbox: run a command, edit a file, serve a port, clean up.
 *
 *   SGL_API_KEY=x402c_... POD_ID=<an online pod you own> npx tsx examples/pods-sandbox.ts
 *
 * The key needs the pods:control:write scope. Nothing here creates or pays for a pod.
 */
import { PodsClient } from "@singularity-layer/grid";

const pods = new PodsClient({ apiKey: process.env.SGL_API_KEY! });
const podId = process.env.POD_ID!;

const run = await pods.exec(podId, { command: "uname -a && whoami", timeout_seconds: 30 });
console.log(`exit ${run.exit_code}`, run.stdout);

await pods.writeFile(podId, "index.html", "<h1>Hello from my pod</h1>");
console.log((await pods.readFile(podId, "index.html")).content);

// Serve the workspace on 8080 and give it a public URL (shown once).
await pods.exec(podId, { command: "nohup python3 -m http.server 8080 >/dev/null 2>&1 &", timeout_seconds: 10 });
const { port } = await pods.openPort(podId, 8080, "public");
console.log(`open ${port.url}`);

console.log(await pods.listPorts(podId));
await pods.closePort(podId, 8080);
