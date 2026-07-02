// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export const apiVersion = "7.2-preview.1";
export const batchApiVersion = "5.0";
export const markdownCommentsApiVersion = "7.2-preview.4";

export function createEnumMapping<T extends Record<string, string | number>>(enumObject: T): Record<string, T[keyof T]> {
  const mapping: Record<string, T[keyof T]> = {};
  for (const [key, value] of Object.entries(enumObject)) {
    if (typeof key === "string" && typeof value === "number") {
      mapping[key.toLowerCase()] = value as T[keyof T];
    }
  }
  return mapping;
}

export function mapStringToEnum<T extends Record<string, string | number>>(value: string | undefined, enumObject: T, defaultValue?: T[keyof T]): T[keyof T] | undefined {
  if (!value) return defaultValue;
  const enumMapping = createEnumMapping(enumObject);
  return enumMapping[value.toLowerCase()] ?? defaultValue;
}

/**
 * Maps an array of strings to an array of enum values, filtering out invalid values.
 * @param values Array of string values to map
 * @param enumObject The enum object to map to
 * @returns Array of valid enum values
 */
export function mapStringArrayToEnum<T extends Record<string, string | number>>(values: string[] | undefined, enumObject: T): T[keyof T][] {
  if (!values) return [];
  return values.map((value) => mapStringToEnum(value, enumObject)).filter((v): v is T[keyof T] => v !== undefined);
}

/**
 * Converts a TypeScript numeric enum to an array of string keys for use with z.enum().
 * This ensures that enum schemas generate string values rather than numeric values.
 * @param enumObject The TypeScript enum object
 * @returns Array of string keys from the enum
 */
export function getEnumKeys<T extends Record<string, string | number>>(enumObject: T): string[] {
  return Object.keys(enumObject).filter((key) => isNaN(Number(key)));
}

/**
 * Safely converts a string enum key to its corresponding enum value.
 * Validates that the key exists in the enum before conversion.
 * @param enumObject The TypeScript enum object
 * @param key The string key to convert
 * @returns The enum value if key is valid, undefined otherwise
 */
export function safeEnumConvert<T extends Record<string, string | number>>(enumObject: T, key: string | undefined): T[keyof T] | undefined {
  if (!key) return undefined;

  const validKeys = getEnumKeys(enumObject);
  if (!validKeys.includes(key)) {
    return undefined;
  }

  return enumObject[key as keyof T];
}

/**
 * Encodes `>` and `<` for Markdown formatted fields.
 *
 * @param value The text value to encode
 * @param format The format of the field ('Markdown' or 'Html')
 * @returns The encoded text, or original text if format is not Markdown
 */
export function encodeFormattedValue(value: string, format?: "Markdown" | "Html"): string {
  if (!value || format !== "Markdown") return value;
  const result = value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return result;
}

/**
 * Detects whether a string returned from an ADO API stream is actually an error
 * response serialized as JSON (e.g. a 404 GitItemNotFoundException or
 * WikiPageNotFoundException) rather than real content.
 *
 * The ADO Node API client swallows non-2xx HTTP responses and delivers the
 * error body as a stream, so callers must check explicitly after reading.
 *
 * @returns The human-readable error message extracted from the JSON, or null if
 *          the content is not an ADO error response.
 */
export function extractAdoStreamError(content: string): string | null {
  try {
    const json = JSON.parse(content.trim());
    if (json && typeof json.typeName === "string" && typeof json.message === "string") {
      return json.message;
    }
  } catch {
    // Not JSON — not an ADO error response.
  }
  return null;
}

/**
 * Extracts the Azure DevOps organization identifier from a URL.
 *
 * Only recognized Azure DevOps hosts are accepted; any other host returns null
 * so that callers can treat unrecognized URLs as a boundary violation.
 *
 * Supports both modern and legacy organization URL forms:
 *  - https://dev.azure.com/{org}/...            -> org is the first path segment
 *  - https://{org}.visualstudio.com/...         -> org is the host subdomain
 *
 * @param url Any Azure DevOps URL (e.g. a wiki page link or a connection serverUrl).
 * @returns The lowercased organization name, or null if it cannot be determined.
 */
export function getOrgFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === "visualstudio.com" || host.endsWith(".visualstudio.com")) {
      const subdomain = host.split(".")[0];
      return subdomain && subdomain !== "visualstudio" ? subdomain : null;
    }
    if (host === "dev.azure.com" || host.endsWith(".dev.azure.com")) {
      const firstSegment = u.pathname.split("/").filter(Boolean)[0];
      return firstSegment ? firstSegment.toLowerCase() : null;
    }
    return null;
  } catch {
    return null;
  }
}

function getCollectionNameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const segment = u.pathname.split("/").filter(Boolean)[0];
    return segment ? decodeURIComponent(segment).toLowerCase() : null;
  } catch {
    return null;
  }
}

export function isAzureDevOpsServicesUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "dev.azure.com" || host.endsWith(".dev.azure.com") || host.endsWith(".visualstudio.com");
  } catch {
    return false;
  }
}

function normalizeOrganizationUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function collectionUrlFromPageUrl(url: string): string {
  const parsed = new URL(url);
  const collectionSegment = parsed.pathname.split("/").filter(Boolean)[0];
  if (!collectionSegment) {
    throw new Error(`Could not determine collection from URL: ${url}`);
  }
  return normalizeOrganizationUrl(`${parsed.origin}/${collectionSegment}`);
}

function getCollectionSegmentFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const segment = u.pathname.split("/").filter(Boolean)[0];
    return segment ? decodeURIComponent(segment) : null;
  } catch {
    return null;
  }
}

function getServerBaseUrl(url: string): string {
  return normalizeOrganizationUrl(new URL(url).origin);
}

export function buildCollectionUrl(serverBaseUrl: string, collection: string): string {
  return `${normalizeOrganizationUrl(serverBaseUrl)}/${collection}`;
}

export function resolveOrganizationConfig(
  organization: string,
  serverUrlOverride?: string
): {
  organizationName: string;
  organizationUrl: string;
  serverBaseUrl: string;
  defaultCollection: string;
} {
  const explicitServerUrl = serverUrlOverride?.trim() || process.env.AZURE_DEVOPS_SERVER_URL?.trim();
  if (explicitServerUrl) {
    const normalizedUrl = organization.startsWith("http://") || organization.startsWith("https://") ? collectionUrlFromPageUrl(organization) : normalizeOrganizationUrl(explicitServerUrl);
    if (isAzureDevOpsServicesUrl(normalizedUrl)) {
      const organizationName = getOrgFromUrl(normalizedUrl) ?? getCollectionNameFromUrl(normalizedUrl) ?? organization;
      return {
        organizationName,
        organizationUrl: normalizedUrl,
        serverBaseUrl: normalizedUrl,
        defaultCollection: organizationName,
      };
    }

    const collectionFromUrl = getCollectionSegmentFromUrl(normalizedUrl);
    const serverBaseUrl = getServerBaseUrl(normalizedUrl);
    const defaultCollection = collectionFromUrl ?? (organization === "_" || organization === "-" ? "" : organization);
    return {
      organizationName: defaultCollection ? defaultCollection.toLowerCase() : "",
      organizationUrl: defaultCollection ? buildCollectionUrl(serverBaseUrl, defaultCollection) : serverBaseUrl,
      serverBaseUrl,
      defaultCollection,
    };
  }

  if (organization.startsWith("http://") || organization.startsWith("https://")) {
    const organizationUrl = collectionUrlFromPageUrl(organization);
    const collectionFromUrl = getCollectionSegmentFromUrl(organizationUrl);
    const serverBaseUrl = getServerBaseUrl(organizationUrl);
    const defaultCollection = collectionFromUrl ?? organization;
    return {
      organizationName: defaultCollection.toLowerCase(),
      organizationUrl: buildCollectionUrl(serverBaseUrl, defaultCollection),
      serverBaseUrl,
      defaultCollection,
    };
  }

  const organizationUrl = normalizeOrganizationUrl(`https://dev.azure.com/${organization}`);
  return {
    organizationName: organization,
    organizationUrl,
    serverBaseUrl: organizationUrl,
    defaultCollection: organization,
  };
}

export function getSearchBaseUrl(serverUrl: string, organizationName: string): string {
  if (isAzureDevOpsServicesUrl(serverUrl)) {
    return `https://almsearch.dev.azure.com/${organizationName}`;
  }
  return normalizeOrganizationUrl(serverUrl);
}

export function getIdentityBaseUrl(serverUrl: string, organizationName: string): string {
  if (isAzureDevOpsServicesUrl(serverUrl)) {
    return `https://vssps.dev.azure.com/${organizationName}`;
  }
  return normalizeOrganizationUrl(serverUrl);
}

/**
 * Convert a Node.js ReadableStream to a string.
 * Shared utility for consistent stream handling across tools.
 */
export function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(data));
  });
}
