import { once } from "node:events";
import { hostname as getHostname } from "node:os";
import { createInterface } from "node:readline";
import net from "node:net";
import tls from "node:tls";

export interface SmtpSendInput {
  from: string;
  host: string;
  password?: string;
  port: number;
  secure: boolean;
  subject: string;
  text: string;
  timeoutMs?: number;
  to: string[];
  username?: string;
}

interface SmtpResponse {
  code: number;
  lines: string[];
}

class LineReader {
  private readonly queue: string[] = [];
  private readonly waiters: Array<(line: string) => void> = [];
  private ended = false;

  constructor(private readonly input: NodeJS.ReadableStream) {
    const rl = createInterface({ input });

    rl.on("line", (line) => {
      const waiter = this.waiters.shift();

      if (waiter) {
        waiter(line);
        return;
      }

      this.queue.push(line);
    });

    rl.on("close", () => {
      this.ended = true;

      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift();

        if (waiter) {
          waiter("");
        }
      }
    });
  }

  async readLine(timeoutMs: number): Promise<string> {
    if (this.queue.length > 0) {
      return this.queue.shift() ?? "";
    }

    if (this.ended) {
      throw new Error("SMTP connection closed before a response line was received");
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutMs} ms while waiting for SMTP response`));
      }, timeoutMs);
      timer.unref();

      this.waiters.push((line) => {
        clearTimeout(timer);

        if (!line && this.ended) {
          reject(new Error("SMTP connection closed before a response line was received"));
          return;
        }

        resolve(line);
      });
    });
  }
}

function buildMessage(input: {
  from: string;
  subject: string;
  text: string;
  to: string[];
}) {
  const normalizedBody = input.text
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");

  return [
    `From: ${input.from}`,
    `To: ${input.to.join(", ")}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    normalizedBody,
    "",
  ].join("\r\n");
}

function writeLine(socket: NodeJS.WritableStream, value: string) {
  return new Promise<void>((resolve, reject) => {
    socket.write(`${value}\r\n`, (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function writeRaw(socket: NodeJS.WritableStream, value: string) {
  return new Promise<void>((resolve, reject) => {
    socket.write(value, (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function readResponse(reader: LineReader, timeoutMs: number): Promise<SmtpResponse> {
  const firstLine = await reader.readLine(timeoutMs);
  const match = /^(\d{3})([\s-])(.*)$/.exec(firstLine);

  if (!match) {
    throw new Error(`Invalid SMTP response line: ${firstLine}`);
  }

  const code = Number(match[1]);
  const lines = [firstLine];

  if (match[2] === "-") {
    while (true) {
      const line = await reader.readLine(timeoutMs);
      lines.push(line);

      if (line.startsWith(`${match[1]} `)) {
        break;
      }
    }
  }

  return {
    code,
    lines,
  };
}

function ensureExpectedCode(response: SmtpResponse, expected: number | number[], action: string) {
  const allowed = Array.isArray(expected) ? expected : [expected];

  if (allowed.includes(response.code)) {
    return;
  }

  throw new Error(`${action} failed with SMTP ${response.code}: ${response.lines.join(" | ")}`);
}

function responseSupportsStartTls(response: SmtpResponse) {
  return response.lines.some((line) => line.toUpperCase().includes("STARTTLS"));
}

async function connectPlainSocket(host: string, port: number, timeoutMs: number) {
  const socket = net.connect({ host, port });
  socket.setTimeout(timeoutMs);
  socket.once("timeout", () => {
    socket.destroy(new Error(`Timed out after ${timeoutMs} ms while connecting to SMTP server`));
  });
  await once(socket, "connect");
  return socket;
}

async function connectSecureSocket(host: string, port: number, timeoutMs: number) {
  const socket = tls.connect({
    host,
    port,
    servername: host,
  });
  socket.setTimeout(timeoutMs);
  socket.once("timeout", () => {
    socket.destroy(new Error(`Timed out after ${timeoutMs} ms while connecting to SMTP server`));
  });
  await once(socket, "secureConnect");
  return socket;
}

async function upgradeSocketToTls(
  socket: net.Socket,
  host: string,
  timeoutMs: number,
) {
  const secureSocket = tls.connect({
    servername: host,
    socket,
  });
  secureSocket.setTimeout(timeoutMs);
  secureSocket.once("timeout", () => {
    secureSocket.destroy(new Error(`Timed out after ${timeoutMs} ms while upgrading SMTP connection to TLS`));
  });
  await once(secureSocket, "secureConnect");
  return secureSocket;
}

async function runAuth(
  socket: NodeJS.WritableStream,
  reader: LineReader,
  input: SmtpSendInput,
  timeoutMs: number,
) {
  if (!input.username || !input.password) {
    return;
  }

  const plainToken = Buffer.from(`\0${input.username}\0${input.password}`, "utf8").toString("base64");
  await writeLine(socket, `AUTH PLAIN ${plainToken}`);
  let response = await readResponse(reader, timeoutMs);

  if (response.code === 235) {
    return;
  }

  await writeLine(socket, "AUTH LOGIN");
  response = await readResponse(reader, timeoutMs);
  ensureExpectedCode(response, 334, "SMTP AUTH LOGIN");

  await writeLine(socket, Buffer.from(input.username, "utf8").toString("base64"));
  response = await readResponse(reader, timeoutMs);
  ensureExpectedCode(response, 334, "SMTP AUTH LOGIN username");

  await writeLine(socket, Buffer.from(input.password, "utf8").toString("base64"));
  response = await readResponse(reader, timeoutMs);
  ensureExpectedCode(response, 235, "SMTP AUTH LOGIN password");
}

export async function sendSmtpMail(input: SmtpSendInput) {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const ehloHost = getHostname() || "localhost";
  let socket: net.Socket | tls.TLSSocket | undefined;
  let reader: LineReader | undefined;

  try {
    socket = input.secure
      ? await connectSecureSocket(input.host, input.port, timeoutMs)
      : await connectPlainSocket(input.host, input.port, timeoutMs);
    reader = new LineReader(socket);

    let response = await readResponse(reader, timeoutMs);
    ensureExpectedCode(response, 220, "SMTP greeting");

    await writeLine(socket, `EHLO ${ehloHost}`);
    response = await readResponse(reader, timeoutMs);
    ensureExpectedCode(response, 250, "SMTP EHLO");

    if (!input.secure && responseSupportsStartTls(response)) {
      await writeLine(socket, "STARTTLS");
      response = await readResponse(reader, timeoutMs);
      ensureExpectedCode(response, 220, "SMTP STARTTLS");

      socket = await upgradeSocketToTls(socket, input.host, timeoutMs);
      reader = new LineReader(socket);

      await writeLine(socket, `EHLO ${ehloHost}`);
      response = await readResponse(reader, timeoutMs);
      ensureExpectedCode(response, 250, "SMTP EHLO after STARTTLS");
    }

    await runAuth(socket, reader, input, timeoutMs);

    await writeLine(socket, `MAIL FROM:<${input.from}>`);
    response = await readResponse(reader, timeoutMs);
    ensureExpectedCode(response, 250, "SMTP MAIL FROM");

    for (const recipient of input.to) {
      await writeLine(socket, `RCPT TO:<${recipient}>`);
      response = await readResponse(reader, timeoutMs);
      ensureExpectedCode(response, [250, 251], "SMTP RCPT TO");
    }

    await writeLine(socket, "DATA");
    response = await readResponse(reader, timeoutMs);
    ensureExpectedCode(response, 354, "SMTP DATA");

    await writeRaw(socket, `${buildMessage(input)}\r\n.\r\n`);
    response = await readResponse(reader, timeoutMs);
    ensureExpectedCode(response, 250, "SMTP message body");

    await writeLine(socket, "QUIT");
    await readResponse(reader, timeoutMs);
  } finally {
    socket?.end();
  }
}
