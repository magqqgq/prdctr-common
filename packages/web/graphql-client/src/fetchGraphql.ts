import { DataError, FetchError, type GraphqlError, NetworkError } from "./errors";
import { assembleDocument, FragmentRegistry } from "./fragments";

/**
 * A source of fragment definitions to resolve against a query: either a
 * `FragmentRegistry` or a plain map of `name -> full fragment definition`.
 */
export type FragmentSource = FragmentRegistry | Record<string, string>;

/** Default ceiling for a request before it is aborted, when the caller sets no explicit timeout. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** A single GraphQL request. One options object, so no argument-order mistakes. */
export interface GraphqlRequest {
	/** Absolute URL of the GraphQL endpoint. */
	url: string;
	/** The GraphQL document to execute. */
	query: string;
	/** Variables for the document. Defaults to `{}`. */
	variables?: Record<string, unknown>;
	/** Fragments to resolve against `query` and append to the request body. */
	fragments?: FragmentSource;
	/** Extra headers, merged over the default `Content-Type: application/json`. */
	headers?: Record<string, string>;
	/** Abort signal for cancellation. */
	signal?: AbortSignal;
	/** Request ceiling in milliseconds. Defaults to `DEFAULT_REQUEST_TIMEOUT_MS`. */
	timeoutMs?: number;
}

type GraphqlEnvelope<T> = { data?: T | null; errors?: GraphqlError[] };

/**
 * Execute a GraphQL query over HTTP POST and return its `data` payload.
 *
 * `T` is the shape of the `data` object; this function is generic over it and
 * performs no domain-level parsing - validate the payload at the call site.
 *
 * Failure postconditions (each extends `NonFatalError`):
 *  - transport rejection (offline, DNS, CORS, abort, timeout) -> `NetworkError`
 *  - non-OK HTTP status                                       -> `FetchError`
 *  - body has `errors` and no `data`                          -> `DataError`
 *  - body is not a JSON object or has a malformed `errors`    -> `DataError`
 */
export async function fetchGraphql<T>(request: GraphqlRequest): Promise<T> {
	const { url, query, variables = {}, fragments, headers, signal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = request;

	const document = resolveDocument(query, fragments);

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify({ query: document, variables }),
			signal: combineSignals(signal, timeoutMs),
		});
	} catch (cause) {
		throw new NetworkError(url, cause);
	}

	if (!response.ok) {
		throw new FetchError(url, response.status, response.statusText || undefined);
	}

	const envelope = parseEnvelope(await response.json());

	if (envelope.data == null) {
		const errors = envelope.errors ?? [];
		throw new DataError(errors[0]?.message ?? "GraphQL request returned no data", errors);
	}

	return envelope.data as T;
}

/**
 * Merge an optional caller signal with a hard timeout into a single signal.
 * Whichever fires first aborts the request, so a hung endpoint cannot keep the
 * caller suspended forever while explicit cancellation still works.
 */
function combineSignals(callerSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const controller = new AbortController();

	if (callerSignal?.aborted) {
		controller.abort(callerSignal.reason);
		return controller.signal;
	}

	const timeout = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
	const onCallerAbort = (): void => controller.abort(callerSignal?.reason);

	callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
	controller.signal.addEventListener(
		"abort",
		() => {
			clearTimeout(timeout);
			callerSignal?.removeEventListener("abort", onCallerAbort);
		},
		{ once: true },
	);

	return controller.signal;
}

/**
 * Minimal runtime guard on the untrusted HTTP response before it reaches
 * application code. Full schema validation is left to the call site, but a
 * non-object body or a malformed `errors` array is rejected here so it cannot
 * crash or be misinterpreted downstream.
 */
function parseEnvelope(json: unknown): GraphqlEnvelope<unknown> {
	if (typeof json !== "object" || json === null || Array.isArray(json)) {
		throw new DataError("GraphQL response body is not a JSON object");
	}

	const data = (json as Record<string, unknown>).data;
	const errors = (json as Record<string, unknown>).errors;

	if (errors !== undefined) {
		if (
			!Array.isArray(errors) ||
			errors.some((entry) => typeof entry !== "object" || entry === null || typeof (entry as { message: unknown }).message !== "string")
		) {
			throw new DataError("GraphQL response body has a malformed errors array");
		}
	}

	if (data !== undefined && data !== null && (typeof data !== "object" || Array.isArray(data))) {
		throw new DataError("GraphQL response body has a malformed data field");
	}

	return { data, errors: errors as GraphqlError[] | undefined };
}

function resolveDocument(query: string, fragments?: FragmentSource): string {
	if (fragments === undefined) return query;
	if (fragments instanceof FragmentRegistry) return fragments.resolve(query);
	return assembleDocument(query, (name) => fragments[name]);
}
