import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { BlockList, connect, createServer, isIPv4 } from "node:net";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import { logOutside } from "../log-sink";
import { removeSocketDir, socketDir, viewSocket } from "./relay";
import { MAX_HELLO_BYTES, readHello } from "./tls-hello";

/**
 * The only way out of a view with its own network namespace. The bot serves
 * an HTTP CONNECT proxy on a unix socket in a private directory under `.data`;
 * the view gets that directory at `NET_VIEW_DIR`, and `net.sh` starts `socat`
 * inside to turn it into `127.0.0.1:NET_VIEW_PORT`, where the proxy variables
 * point. A tunnel opens only to port 443 of an allowed host, and only when
 * every address the name resolves to is public: loopback, the tailnet and the
 * LAN stay out of reach whatever the name says. The tunnel then carries bytes
 * only after the client's TLS ClientHello names that same host, so a shared
 * edge address cannot be used to reach another site it fronts.
 *
 * `NetPolicy.endpoint` is the other rule: the exact `host:port` of the run's
 * model, the `baseUrl` pi runs it on, a catalog host on 443 as much as a
 * custom port (a pi view gets no `hosts`, only this). That one target opens
 * on its port at the addresses its name first resolved to for the proxy's
 * life, so a later answer cannot move it elsewhere, and only when every one
 * of them is public: a `baseUrl` on loopback or the LAN stays refused, even
 * when it is the model's own (local models are off; `piModelReach` refuses
 * them before a run starts). Its tunnel is checked for a ClientHello naming
 * the host when it is `https` by name; plain HTTP and an IP literal carry
 * none. Every other port of that host stays refused.
 */

/** Where the proxy directory appears inside the view. */
export const NET_VIEW_DIR = "/tmp/.bot-net";

/** The loopback port inside the view; the view's namespace is its own. */
const NET_VIEW_PORT = 3128;

/** Starts `socat` inside the view, waits for its port, then runs the CLI. */
export const NET_LAUNCHER = fileURLToPath(new URL("net.sh", import.meta.url));

/**
 * The model's own endpoint, as its provider names it: an exact host (an IP
 * literal unbracketed, or a lowercased name) and port. `sni` says the client
 * speaks TLS to it by name, so its ClientHello must carry that name.
 */
export interface NetEndpoint {
  host: string;
  port: number;
  sni: boolean;
}

/** What a view may reach: the provider's named hosts, and maybe one endpoint. */
export interface NetPolicy {
  endpoint?: NetEndpoint;
  hosts: readonly string[];
}

/** Where a tunnel may go, and whether its ClientHello must name the host. */
type Verdict =
  | { addresses: string[]; sni: boolean }
  | { refused: NetRefusal["reason"] };

/** One tunnel the proxy would not open, for the log. */
interface NetRefusal {
  host: string;
  port: number;
  reason: "address" | "host" | "port" | "request" | "sni";
}

/** An open proxy; `close` cuts every tunnel and removes the socket. */
export interface NetProxy {
  close: () => void;
  /** The host directory holding the socket, bound at `NET_VIEW_DIR`. */
  dir: string;
}

const HTTPS_PORT = 443;
const DIAL_TIMEOUT_MS = 10_000;
const MAX_HEAD_BYTES = 8192;
/** Distinct refusals logged per proxy; past it, one line says the rest are dropped. */
const MAX_LOGGED_REFUSALS = 32;
/** Sockets one proxy holds at once, clients and upstreams together. */
const MAX_OPEN_SOCKETS = 128;
const HEAD_END = "\r\n\r\n";
const HEAD_END_BYTES = Buffer.byteLength(HEAD_END);
const CONNECT_LINE = /^CONNECT (?<target>\S+) HTTP\/1\.[01]$/u;
const MAPPED_V4 = /^::ffff:(?<v4>\d+\.\d+\.\d+\.\d+)$/iu;
const BRACKETED = /^\[(?<inner>.*)\]$/u;
const TRAILING_DOT = /\.$/u;

/** Addresses no tunnel may reach: loopback, private, tailnet, link-local. */
const NOT_PUBLIC_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/3",
];
const NOT_PUBLIC_V6 = ["::/127", "fc00::/7", "fe80::/10", "ff00::/8"];

const NOT_PUBLIC = (() => {
  const list = new BlockList();
  const add = (cidr: string, family: "ipv4" | "ipv6") => {
    const [net = "", prefix = ""] = cidr.split("/");
    list.addSubnet(net, Number(prefix), family);
  };
  for (const cidr of NOT_PUBLIC_V4) {
    add(cidr, "ipv4");
  }
  for (const cidr of NOT_PUBLIC_V6) {
    add(cidr, "ipv6");
  }
  return list;
})();

/** Whether an IP address is public: not loopback, private, tailnet or link-local. */
const isPublic = (address: string) => {
  const v4 = MAPPED_V4.exec(address)?.groups?.v4 ?? address;
  return isIPv4(v4)
    ? !NOT_PUBLIC.check(v4, "ipv4")
    : !NOT_PUBLIC.check(address, "ipv6");
};

/** The target of a CONNECT request head, host lowercased and unbracketed. */
const parseConnect = (head: string) => {
  const [line = ""] = head.split("\r\n", 1);
  const target = CONNECT_LINE.exec(line)?.groups?.target ?? "";
  const at = target.lastIndexOf(":");
  return at > 0
    ? {
        host: target
          .slice(0, at)
          .replace(BRACKETED, "$<inner>")
          .replace(TRAILING_DOT, "")
          .toLowerCase(),
        port: Number(target.slice(at + 1)),
      }
    : undefined;
};

/** Every address `host` resolves to; none when it does not resolve. */
const resolveAll = async (host: string) => {
  try {
    return await lookup(host, { all: true });
  } catch {
    return [];
  }
};

/**
 * Whether `host`, an IP literal or a name, is local: any address it is or
 * resolves to is not public (`isPublic`). Undefined when it resolves to
 * nothing.
 */
export const hostIsLocal = async (host: string) => {
  const found = await resolveAll(host);
  return found.length === 0
    ? undefined
    : found.some((entry) => !isPublic(entry.address));
};

/** The addresses of a lookup, IPv4 first. */
const ipv4First = (found: readonly { address: string }[]) =>
  [
    ...found.filter((entry) => isIPv4(entry.address)),
    ...found.filter((entry) => !isIPv4(entry.address)),
  ].map((entry) => entry.address);

/** The addresses to dial for an allowed host on 443, or why there are none. */
const decideHost = async (
  hosts: readonly string[],
  host: string,
  port: number
): Promise<Verdict> => {
  if (port !== HTTPS_PORT) {
    return { refused: "port" };
  }
  if (!hosts.includes(host)) {
    return { refused: "host" };
  }
  const found = await resolveAll(host);
  return found.length > 0 && found.every((entry) => isPublic(entry.address))
    ? { addresses: ipv4First(found), sni: true }
    : { refused: "address" };
};

/**
 * `host`'s addresses, looked up once and kept: a name that answers
 * differently later still dials where it first pointed. A lookup that finds
 * nothing is tried again next time.
 */
const pinned = (host: string) => {
  let found: Promise<string[]> | undefined;
  return async () => {
    found ??= (async () => ipv4First(await resolveAll(host)))();
    const addresses = await found;
    if (addresses.length === 0) {
      found = undefined;
    }
    return addresses;
  };
};

/** What `policy` says of each `host:port` a client asks for. */
const netRules = (policy: NetPolicy) => {
  const { endpoint } = policy;
  const endpointAddresses =
    endpoint === undefined ? undefined : pinned(endpoint.host);
  return async (host: string, port: number): Promise<Verdict> => {
    if (
      endpoint === undefined ||
      endpointAddresses === undefined ||
      endpoint.host !== host ||
      endpoint.port !== port
    ) {
      return await decideHost(policy.hosts, host, port);
    }
    const addresses = await endpointAddresses();
    return addresses.length > 0 && addresses.every(isPublic)
      ? { addresses, sni: endpoint.sni }
      : { refused: "address" };
  };
};

/** Whether `socket` connects within the timeout. */
const opens = async (socket: Socket) => {
  try {
    await once(socket, "connect", {
      signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
    });
    return true;
  } catch {
    socket.destroy();
    return false;
  }
};

/** A socket to the first address that answers, tried in order. */
const dial = async (
  addresses: readonly string[],
  port: number
): Promise<Socket | undefined> => {
  for (const address of addresses) {
    const socket = connect({ host: address, port });
    // oxlint-disable-next-line no-await-in-loop -- one address at a time, in order
    if (await opens(socket)) {
      return socket;
    }
  }
  return undefined;
};

/** What a client that sends no usable hello reads as. */
const NO_HELLO = {};

/**
 * The client's first bytes once the tunnel is up, read until its ClientHello
 * is whole, with the server name it carries. A client that sends no such
 * hello in time, or more bytes than one record, gets no name.
 */
const awaitHello = async (client: Socket, first: Buffer) => {
  let bytes = first;
  const named = Promise.withResolvers<{ sni?: string }>();
  const onData = (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
    const read = readHello(bytes);
    if (read.done || bytes.length > MAX_HELLO_BYTES) {
      named.resolve(read.done ? read : NO_HELLO);
    }
  };
  const onClose = () => {
    named.resolve(NO_HELLO);
  };
  const timer = setTimeout(onClose, DIAL_TIMEOUT_MS);
  client.on("data", onData);
  client.on("close", onClose);
  client.resume();
  onData(Buffer.alloc(0));
  const { sni } = await named.promise;
  clearTimeout(timer);
  client.off("data", onData);
  client.off("close", onClose);
  client.pause();
  return { bytes, sni };
};

const answer = (client: Socket, status: string) => {
  client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
};

/** Serve one CONNECT whose head has fully arrived; `rest` came after it. */
const tunnel = async (input: {
  client: Socket;
  head: string;
  decide: ReturnType<typeof netRules>;
  onRefused: (refusal: NetRefusal) => void;
  open: Set<Socket>;
  rest: Buffer;
}) => {
  const { client } = input;
  const target = parseConnect(input.head);
  if (target === undefined) {
    input.onRefused({ host: "", port: 0, reason: "request" });
    answer(client, "405 Method Not Allowed");
    return;
  }
  const verdict = await input.decide(target.host, target.port);
  if ("refused" in verdict) {
    input.onRefused({ ...target, reason: verdict.refused });
    answer(client, "403 Forbidden");
    return;
  }
  const upstream = await dial(verdict.addresses, target.port);
  if (upstream === undefined) {
    answer(client, "502 Bad Gateway");
    return;
  }
  if (client.destroyed) {
    upstream.destroy();
    return;
  }
  input.open.add(upstream);
  upstream.on("close", () => {
    input.open.delete(upstream);
    client.destroy();
  });
  upstream.on("error", () => {
    upstream.destroy();
  });
  client.on("close", () => {
    upstream.destroy();
  });
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (verdict.sni) {
    const hello = await awaitHello(client, input.rest);
    if (hello.sni !== target.host) {
      input.onRefused({ ...target, reason: "sni" });
      client.destroy();
      return;
    }
    upstream.write(hello.bytes);
  } else {
    upstream.write(input.rest);
  }
  client.pipe(upstream);
  upstream.pipe(client);
};

/** `tunnel`, with any failure ending the client's connection. */
const serve = async (input: Parameters<typeof tunnel>[0]) => {
  try {
    await tunnel(input);
  } catch {
    input.client.destroy();
  }
};

/**
 * A warning per distinct refusal, up to `MAX_LOGGED_REFUSALS`, then one line
 * that the rest are dropped: a loop over one target logs once, a loop over
 * many names logs a bounded amount and keeps a bounded set.
 */
const refusalLog = () => {
  const seen = new Set<string>();
  return (refusal: NetRefusal) => {
    const key = `${refusal.reason} ${refusal.host}:${refusal.port}`;
    if (seen.has(key) || seen.size > MAX_LOGGED_REFUSALS) {
      return;
    }
    seen.add(key);
    logOutside(
      seen.size > MAX_LOGGED_REFUSALS
        ? Effect.logWarning("Sandbox network refusals suppressed", {
            after: MAX_LOGGED_REFUSALS,
          })
        : Effect.logWarning("Sandbox network refused", refusal)
    );
  };
};

/** Start a proxy that opens tunnels only where `policy` allows. */
export const openNetProxy = async (policy: NetPolicy) => {
  const { dir, socket } = socketDir("n");
  const decide = netRules(policy);
  const onRefused = refusalLog();
  const open = new Set<Socket>();
  const server = createServer((client) => {
    if (open.size >= MAX_OPEN_SOCKETS) {
      client.destroy();
      return;
    }
    open.add(client);
    client.on("close", () => {
      open.delete(client);
    });
    client.on("error", () => {
      client.destroy();
    });
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(HEAD_END);
      if (end === -1) {
        if (head.length > MAX_HEAD_BYTES) {
          client.off("data", onData);
          answer(client, "431 Request Header Fields Too Large");
        }
        return;
      }
      client.off("data", onData);
      client.pause();
      void serve({
        client,
        decide,
        head: head.subarray(0, end).toString("latin1"),
        onRefused,
        open,
        rest: head.subarray(end + HEAD_END_BYTES),
      });
    };
    client.on("data", onData);
  });
  server.listen(socket);
  await once(server, "listening");
  return {
    close: () => {
      server.close();
      for (const conn of open) {
        conn.destroy();
      }
      removeSocketDir(dir);
    },
    dir,
  };
};

/** The CLI, started inside the view behind `socat` on the proxy socket. */
export const netCommand = (socat: string, command: readonly string[]) => [
  "/bin/sh",
  NET_LAUNCHER,
  socat,
  String(NET_VIEW_PORT),
  viewSocket(NET_VIEW_DIR),
  ...command,
];

/**
 * The variables that send a CLI's HTTP through the proxy. They replace any
 * the host set: inside the view nothing else is reachable.
 */
export const netProxyEnv = () => {
  const url = `http://127.0.0.1:${NET_VIEW_PORT}`;
  return {
    ALL_PROXY: url,
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    NO_PROXY: "",
    all_proxy: url,
    http_proxy: url,
    https_proxy: url,
    no_proxy: "",
  };
};
