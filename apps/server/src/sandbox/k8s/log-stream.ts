import { PassThrough } from "node:stream";
import type { Log } from "@kubernetes/client-node";

/** Stream a pod's stdout (follow) and forward complete lines. Resolves when the
 *  log stream closes (pod terminated). Mirrors the docker adapter's line buffer. */
export function streamPodLog(
  log: Log,
  namespace: string,
  pod: string,
  container: string,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = new PassThrough();
    let buf = "";
    stream.setEncoding("utf-8");
    stream.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > 0) {
          try {
            onLine(line);
          } catch {
            /* swallow listener errors */
          }
        }
      }
    });
    stream.on("end", () => {
      if (buf.length > 0) {
        try {
          onLine(buf);
        } catch {
          /* swallow listener errors */
        }
      }
      resolve();
    });
    stream.on("error", reject);
    // follow: stream until the container terminates. log() resolves with an
    // AbortController once the request is established; we don't need it here
    // since resolution/rejection is driven by the stream's own end/error events.
    log.log(namespace, pod, container, stream, { follow: true, pretty: false }).catch(reject);
  });
}
