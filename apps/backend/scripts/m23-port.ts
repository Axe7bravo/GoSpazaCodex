import { createConnection } from "node:net";
// Readiness probes may use HTTP; ownership must also reject non-HTTP listeners.
export async function requireM23PortFree() {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "localhost", port: 9000 });
    socket.setTimeout(1500);
    socket.once("connect", () => { socket.destroy(); reject(Error("Stop the existing listener on port 9000; M23 acceptance owns its built backend.")); });
    socket.once("timeout", () => { socket.destroy(); reject(Error("Cannot establish ownership of port 9000.")); });
    socket.once("error", (error: NodeJS.ErrnoException) => { socket.destroy(); if (error.code === "ECONNREFUSED") resolve(); else reject(Error("Cannot establish ownership of port 9000.")); });
  });
}
