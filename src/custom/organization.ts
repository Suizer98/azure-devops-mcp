// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { getOrgFromUrl } from "../utils.js";

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

function getServerOrigin(url: string): string {
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
    const serverBaseUrl = getServerOrigin(normalizedUrl);
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
    const serverBaseUrl = getServerOrigin(organizationUrl);
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
