/**
 * The other User in an end-to-end run: a raw IRC connection over Bun's sockets, with just
 * enough of a Line parser to wait for a command and its parameters. It decides from
 * commands and parameters, never from an Ircd's free text.
 *
 * @packageDocumentation
 */
/** A Line split into its parts, and when it arrived. */
export interface Parsed {
  readonly source: string | undefined;
  readonly command: string;
  readonly params: readonly string[];
  /** When the Peer read it, in milliseconds by the monotonic clock. */
  readonly at: number;
}

/**
 * Splits a Line's text into its parts. Tags are dropped.
 * @param text - The Line, without its line ending.
 * @param at - When it arrived.
 * @returns Its parts.
 */
const parseLine = (text: string, at: number): Parsed => {
  let rest = text.startsWith("@") ? text.slice(text.indexOf(" ") + 1) : text;
  let source: string | undefined;

  if (rest.startsWith(":")) {
    const space = rest.indexOf(" ");

    source = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }

  const trailing = rest.indexOf(" :");
  const words = (trailing === -1 ? rest : rest.slice(0, trailing)).split(" ").filter(Boolean);
  const [command = "", ...params] = words;

  return {
    at,
    command: command.toUpperCase(),
    params: trailing === -1 ? params : [...params, rest.slice(trailing + 2)],
    source,
  };
};

/** A raw IRC connection, as the other User. */
export interface Peer {
  /** Sends a Line, adding its line ending. */
  readonly send: (line: string) => void;
  /** The next Line received that matches, waiting at most `timeout` milliseconds. */
  readonly waitFor: (
    matches: (line: Parsed) => boolean,
    what: string,
    timeout?: number
  ) => Promise<Parsed>;
  readonly close: () => void;
}

/**
 * Connects to an Ircd as a raw IRC client, and registers with no caps.
 * @param options - Where to connect, the nick, and any caps to ask for before registering.
 * @returns The Peer, once `001` has arrived.
 */
export const connectPeer = async (options: {
  readonly host: string;
  readonly port: number;
  readonly nick: string;
  readonly caps?: readonly string[];
}): Promise<Peer> => {
  const lines: Parsed[] = [];
  const waiting = new Set<() => void>();
  let buffered = "";
  const decoder = new TextDecoder();

  const socket = await Bun.connect({
    hostname: options.host,
    port: options.port,
    socket: {
      data: (connection, bytes) => {
        buffered += decoder.decode(bytes, { stream: true });
        const parts = buffered.split(/\r?\n/u);

        buffered = parts.pop() ?? "";

        const at = performance.now();

        for (const text of parts.filter(Boolean)) {
          const parsed = parseLine(text, at);

          // Every Ircd PINGs, and a Peer that never answers is dropped.
          if (parsed.command === "PING") {
            connection.write(`PONG :${parsed.params[0] ?? ""}\r\n`);
          }

          lines.push(parsed);
        }

        for (const wake of waiting) {
          wake();
        }
      },
    },
  });

  const send = (line: string) => {
    socket.write(`${line}\r\n`);
  };

  const waitFor: Peer["waitFor"] = async (matches, what, timeout = 20_000) => {
    const { promise, reject, resolve } = Promise.withResolvers<Parsed>();
    const deadline = AbortSignal.timeout(timeout);

    const look = () => {
      const index = lines.findIndex(matches);
      const [found] = index === -1 ? [] : lines.splice(0, index + 1).slice(-1);

      if (found !== undefined) {
        waiting.delete(look);
        resolve(found);
      }
    };

    deadline.addEventListener(
      "abort",
      () => {
        waiting.delete(look);
        reject(new Error(`the Peer waited ${timeout} ms for ${what}`));
      },
      { once: true }
    );

    waiting.add(look);
    look();

    return await promise;
  };

  if (options.caps !== undefined && options.caps.length > 0) {
    send("CAP LS 302");
    send(`CAP REQ :${options.caps.join(" ")}`);
  }

  send(`NICK ${options.nick}`);
  send(`USER ${options.nick} 0 * :${options.nick}`);

  if (options.caps !== undefined && options.caps.length > 0) {
    await waitFor((line) => line.command === "CAP" && line.params[1] === "ACK", "CAP ACK");
    send("CAP END");
  }

  await waitFor((line) => line.command === "001", "001");

  return {
    close: () => {
      socket.end();
    },
    send,
    waitFor,
  };
};

/**
 * Registers an account on Ergo with `draft/account-registration`, on a Connection of its
 * own that ends once the account exists.
 * @param options - Where Ergo listens, and the account and password.
 * @returns Once the account exists.
 */
export const registerAccount = async (options: {
  readonly host: string;
  readonly port: number;
  readonly account: string;
  readonly password: string;
}): Promise<void> => {
  const peer = await connectPeer({
    caps: ["draft/account-registration"],
    host: options.host,
    nick: options.account,
    port: options.port,
  });

  peer.send(`REGISTER * * ${options.password}`);

  const reply = await peer.waitFor(
    (line) => line.command === "REGISTER" || line.command === "FAIL",
    "REGISTER's reply"
  );

  peer.send("QUIT");
  peer.close();

  if (reply.command !== "REGISTER" || reply.params[0] !== "SUCCESS") {
    throw new Error(
      `could not register ${options.account}: ${reply.command} ${reply.params[0] ?? ""}`
    );
  }
};
