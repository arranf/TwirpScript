import { IncomingMessage, ServerResponse } from "http";
import { TwirpError, statusCodeForErrorCode } from "../error";
import { Emitter, createEventEmitter } from "../eventEmitter";
import { withRequestLogging } from "./requestLogging";

export type ByteSource = ArrayBuffer | Uint8Array | number[] | string;

export interface Response {
  body: string | Buffer;
  headers: {
    [key: string]: string | undefined;
  };
  statusCode: number;
}

export interface Request {
  body: string | Buffer | undefined | null;
  headers: {
    [key: string]: string | undefined;
  };
  url: string;
}

export interface InboundRequest extends Request {
  method: string;
}

type ServerRequest = Pick<
  IncomingMessage,
  "method" | "url" | "headers" | typeof Symbol.asyncIterator
>;

type ServerRequestWithBody<SR extends ServerRequest> = SR &
  Pick<Request, "body">;

type ServiceContext<U> = U extends Service
  ? { service: U | undefined; method: U["methods"][keyof U["methods"]] }
  : never;

export type TwirpContext<
  ContextExt = unknown,
  Services extends Service[] = Service[]
> = ContextExt & {
  /**
   * The requested content-type for the request.
   */
  contentType: "JSON" | "Protobuf" | "Unknown";
} & ServiceContext<Pick<Services, number>[number]>;

interface Message<T> {
  encode: (message: T) => Uint8Array;
  decode: (bytes: ByteSource) => T;
}

export interface ServiceMethod<Context = any> {
  name: string;
  handler: (input: any, ctx: Context) => any;
  input: Message<any>;
  output: Message<any>;
}

interface Service {
  name: string;
  methods: Record<string, ServiceMethod | undefined>;
}

export function TwirpErrorResponse(error: TwirpError): Response {
  return {
    statusCode: statusCodeForErrorCode[error.code],
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(error),
  };
}

function parseJSON<Result>(json: string): Result | undefined {
  try {
    return JSON.parse(json) as Result;
  } catch (e) {
    return undefined;
  }
}

function parseProto<T>(
  proto: ByteSource,
  decode: (proto: ByteSource) => T
): T | undefined {
  try {
    return decode(proto);
  } catch (e) {
    return undefined;
  }
}

export async function executeServiceMethod<Context extends TwirpContext>(
  method: ServiceMethod,
  req: Request,
  context: Context,
  ee: Emitter<ServerHooks<Context, Request>>
): Promise<TwirpError | string | Buffer> {
  try {
    switch (context.contentType) {
      case "JSON": {
        const body = parseJSON(req.body as string);
        if (!body) {
          return new TwirpError({
            code: "invalid_argument",
            msg: `failed to deserialize argument as JSON`,
          });
        }
        ee.emit("requestRouted", context, body as any);
        const response = await method.handler(body as any, context);
        ee.emit("responsePrepared", context, response);
        return JSON.stringify(response);
      }
      case "Protobuf": {
        const body = parseProto(req.body as Buffer, method.input.decode);
        if (!body) {
          return new TwirpError({
            code: "invalid_argument",
            msg: `failed to deserialize argument as Protobuf`,
          });
        }
        ee.emit("requestRouted", context, body);
        const response = await method.handler(body, context);
        ee.emit("responsePrepared", context, response);
        return Buffer.from(method.output.encode(response));
      }
      default: {
        return new TwirpError({
          code: "malformed",
          msg: `Unexpected or missing content-type`,
        });
      }
    }
  } catch (error) {
    if (error instanceof TwirpError) {
      return error;
    } else {
      return new TwirpError({
        code: "internal",
        msg: "server error",
      });
    }
  }
}

async function getBody(req: ServerRequest): Promise<Buffer> {
  const buffers = [];
  for await (const chunk of req) {
    buffers.push(chunk);
  }
  const body = Buffer.concat(buffers);
  return body;
}

function validateRequest(req: InboundRequest): TwirpError | undefined {
  if (!req.url) {
    return new TwirpError({
      code: "malformed",
      msg: `no request url provided`,
    });
  }

  if (!req.method) {
    return new TwirpError({
      code: "malformed",
      msg: `no request method provided`,
    });
  }

  if (req.method !== "POST") {
    return new TwirpError({
      code: "malformed",
      msg: `unexpected request method ${req.method}`,
    });
  }

  const contentType = req.headers["content-type"];
  if (!contentType) {
    return new TwirpError({
      code: "malformed",
      msg: `no request content-type provided`,
    });
  }
  if (
    contentType !== "application/json" &&
    contentType !== "application/protobuf"
  ) {
    return new TwirpError({
      code: "malformed",
      msg: `unexpected request content-type ${contentType}`,
    });
  }
}

type Next = () => Promise<Response>;

interface TwirpServerConfig {
  /**
   * Puts the Twirp server runtime into debug mode when set to true. This enables request logging. Defaults to true.
   */
  debug?: boolean;
  /**
   * A path prefix such as "/my/custom/prefix". Defaults to "/twirp", but can be set to "".
   */
  prefix?: string;
}

export type Middleware<Context = unknown, Request = unknown> = (
  request: Request,
  context: TwirpContext<Context>,
  next: Next
) => Promise<Response>;

export function twirpHandler<Context extends TwirpContext>(
  ee: Emitter<ServerHooks<Context, Request>>
) {
  return async (req: InboundRequest, ctx: Context): Promise<Response> => {
    const err = validateRequest(req);
    if (err) {
      ee.emit("error", ctx, err);
      return TwirpErrorResponse(err);
    }

    const handler = ctx.method;
    if (!handler) {
      const error = new TwirpError({
        code: "bad_route",
        msg: `no handler for path POST ${req.url ?? ""}.`,
      });
      ee.emit("error", ctx, error);
      return TwirpErrorResponse(error);
    }

    const response = await executeServiceMethod(handler, req, ctx, ee);
    if (response instanceof TwirpError) {
      ee.emit("error", ctx, response);
      return TwirpErrorResponse(response);
    }
    return {
      statusCode: 200,
      headers: {
        "content-type": req.headers["content-type"],
      },
      body: response,
    };
  };
}

export type ServerHooks<Context extends TwirpContext, Request> = {
  requestReceived: (context: Context, request: Request) => void;
  requestRouted: (
    context: Context,
    input: ReturnType<NonNullable<Context["method"]>["input"]["decode"]>
  ) => void;
  responsePrepared: (
    context: Context,
    output: ReturnType<NonNullable<Context["method"]>["output"]["decode"]>
  ) => void;
  responseSent: (context: Context, response: Response) => void;
  error: (context: Context, error: TwirpError) => void;
};

export interface TwirpServerRuntime<
  Context extends TwirpContext = TwirpContext,
  Request = InboundRequest
> {
  /**
   * Registers middleware to manipulate the server request / response lifecycle.
   *
   * The middleware handler will receive `request`, `context` and `next` parameters. `request` is the incoming request. `context` is a request context object which will be passed to each middleware handler and finally the Twirp service handler you implemented. `context` enables you to pass extra parameters to your service handlers that are not available via your service's defined request parameters, and can be used to implement things such as authentication or rate limiting. `next` invokes the next handler in the chain -- either the next registered middleware, or the Twirp service handler you implemented.
   *
   * Middleware is called in order of registration, with the Twirp service handler you implemented invoked last.
   */
  use: (middleware: Middleware<Context, Request>) => this;
  /**
   * Registers event handler that can instrument a Twirp-generated server. These callbacks all accept the current request `context` as their first argument.
   *
   * `requestReceived` is called as soon as a request enters the Twirp server at the earliest available moment. Called with the current `context` and the request.
   *
   * `requestRouted` is called when a request has been routed to a service method. Called with the current `context` and the input to the service method.
   *
   * `responsePrepared` is called when a request has been handled by a service method. Called with the current `context` and the response generated by the service method.
   *
   * `responseSent` is called when all bytes of a response (including an error response) have been written. Called with the current `context` and the response.
   *
   * `error` is called when an error occurs while handling a request. Called with the current `context` and the error that occurred.
   *
   */
  on: <Event extends keyof ServerHooks<Context, Request>>(
    event: Event,
    handler: ServerHooks<Context, Request>[Event]
  ) => this;
  /**
   * Removes a registered event handler.
   */
  off: <Event extends keyof ServerHooks<Context, Request>>(
    event: Event,
    handler: ServerHooks<Context, Request>[Event]
  ) => this;
}

interface TwirpServer<
  Context extends TwirpContext,
  Request extends ServerRequest
> extends TwirpServerRuntime<Context, ServerRequestWithBody<Request>> {
  (req: Request, res: ServerResponse): void;
}

interface TwirpServerless<Context extends TwirpContext, Request>
  extends TwirpServerRuntime<Context, Request> {
  (req: Request): Promise<Response>;
}

export function createTwirpServer<
  ContextExt,
  Services extends Service[],
  Request extends ServerRequest = IncomingMessage
>(
  services: Services,
  config: TwirpServerConfig = {}
): TwirpServer<TwirpContext<ContextExt, typeof services>, Request> {
  const _app = createTwirpServerless(services, config);

  async function app(req: Request, res: ServerResponse): Promise<void> {
    const body = await getBody(req);
    const request = req as unknown as InboundRequest;
    request.body = body;
    const response = await _app(request);
    res.writeHead(response.statusCode, response.headers);
    res.end(response.body);
  }

  app.use = (
    handler: Middleware<
      TwirpContext<ContextExt, typeof services>,
      ServerRequestWithBody<Request>
    >
  ) => {
    _app.use(handler as any);
    return app;
  };

  app.on = (
    ...args: Parameters<
      Emitter<
        ServerHooks<
          TwirpContext<ContextExt, typeof services>,
          ServerRequestWithBody<Request>
        >
      >["on"]
    >
  ) => {
    _app.on(...(args as [any, any]));
    return app;
  };

  app.off = (
    ...args: Parameters<
      Emitter<
        ServerHooks<
          TwirpContext<ContextExt, typeof services>,
          ServerRequestWithBody<Request>
        >
      >["off"]
    >
  ) => {
    _app.off(...(args as [any, any]));
    return app;
  };

  return app;
}

const contentTypeName: {
  [key: string]: TwirpContext["contentType"] | undefined;
} = {
  "application/json": "JSON",
  "application/protobuf": "Protobuf",
};

function getRequestContext<Services extends Service[]>(
  req: InboundRequest,
  services: Services,
  config: Required<TwirpServerConfig>
): TwirpContext {
  const ctx = {
    service: undefined,
    method: undefined,
    contentType:
      contentTypeName[req.headers["content-type"] as string] ?? "Unknown",
  } as unknown as TwirpContext;

  const prefix = config.prefix + "/";
  const startsWithPrefix = req.url.startsWith(prefix);
  if (!startsWithPrefix) {
    return ctx;
  }
  const methodIdx = req.url.lastIndexOf("/");
  const serviceName = req.url.slice(prefix.length, methodIdx);
  const serviceMethod = req.url.slice(methodIdx + 1);
  const service = services.find((service) => service.name === serviceName);
  const handler = service?.methods[serviceMethod];
  if (handler) {
    ctx.service = service;
    ctx.method = handler;
  }
  return ctx;
}

export function createTwirpServerless<
  ContextExt,
  Services extends Service[],
  Request extends InboundRequest = InboundRequest
>(
  services: Services,
  config: TwirpServerConfig = {}
): TwirpServerless<TwirpContext<ContextExt, typeof services>, Request> {
  const configWithDefaults = {
    debug: true,
    prefix: "/twirp",
    ...config,
  };
  const serverMiddleware: Middleware<
    TwirpContext<ContextExt, typeof services>,
    Request
  >[] = [];
  const ee =
    createEventEmitter<
      ServerHooks<TwirpContext<ContextExt, Services>, Request>
    >();
  const twirp = twirpHandler<TwirpContext<ContextExt, Services>>(ee);

  async function app(req: Request): Promise<Response> {
    const ctx = getRequestContext(
      req,
      services,
      configWithDefaults
    ) as TwirpContext<ContextExt, Services>;
    ee.emit("requestReceived", ctx, req);

    let response: Response;
    try {
      let idx = 1;
      const middleware = [...serverMiddleware, twirp];
      response = await middleware[0](req, ctx, function next() {
        const nxt = middleware[idx];
        idx++;
        return nxt(req, ctx, next);
      });
    } catch (e) {
      const error =
        e instanceof TwirpError
          ? e
          : new TwirpError({ code: "internal", msg: "server error" });
      ee.emit("error", ctx, error);
      response = TwirpErrorResponse(error);
    }

    ee.emit("responseSent", ctx, response);
    return response;
  }

  app.use = (
    handler: Middleware<TwirpContext<ContextExt, Services>, Request>
  ) => {
    serverMiddleware.push(handler);
    return app;
  };

  app.on = (
    ...args: Parameters<
      Emitter<ServerHooks<TwirpContext<ContextExt, Services>, Request>>["on"]
    >
  ) => {
    ee.on(...args);
    return app;
  };

  app.off = (
    ...args: Parameters<
      Emitter<ServerHooks<TwirpContext<ContextExt, Services>, Request>>["off"]
    >
  ) => {
    ee.off(...args);
    return app;
  };

  if (configWithDefaults.debug !== false) {
    withRequestLogging(app);
  }

  return app;
}
