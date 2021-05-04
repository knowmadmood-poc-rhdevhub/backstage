/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  Entity,
  EntityName,
  Location,
  LOCATION_ANNOTATION,
  ORIGIN_LOCATION_ANNOTATION,
  stringifyEntityRef,
  stringifyLocationReference,
} from '@backstage/catalog-model';
import { ResponseError } from '@backstage/errors';
import fetch from 'cross-fetch';
import {
  AddLocationRequest,
  AddLocationResponse,
  CatalogApi,
  CatalogAttachmentResponse,
  CatalogEntitiesRequest,
  CatalogListResponse,
  CatalogRequestOptions,
  DiscoveryApi,
} from './types';

export class CatalogClient implements CatalogApi {
  private readonly discoveryApi: DiscoveryApi;

  constructor(options: { discoveryApi: DiscoveryApi }) {
    this.discoveryApi = options.discoveryApi;
  }

  async getLocationById(
    id: string,
    options?: CatalogRequestOptions,
  ): Promise<Location | undefined> {
    return await this.requestOptional(
      'GET',
      `/locations/${encodeURIComponent(id)}`,
      options,
    );
  }

  async getEntities(
    request?: CatalogEntitiesRequest,
    options?: CatalogRequestOptions,
  ): Promise<CatalogListResponse<Entity>> {
    const { filter = [], fields = [] } = request ?? {};
    const filterItems = [filter].flat();
    const params: string[] = [];

    // filter param can occur multiple times, for example
    // /api/catalog/entities?filter=metadata.name=wayback-search,kind=component&filter=metadata.name=www-artist,kind=component'
    // the "outer array" defined by `filter` occurrences corresponds to "anyOf" filters
    // the "inner array" defined within a `filter` param corresponds to "allOf" filters
    for (const filterItem of filterItems) {
      const filterParts: string[] = [];
      for (const [key, value] of Object.entries(filterItem)) {
        for (const v of [value].flat()) {
          filterParts.push(
            `${encodeURIComponent(key)}=${encodeURIComponent(v)}`,
          );
        }
      }

      if (filterParts.length) {
        params.push(`filter=${filterParts.join(',')}`);
      }
    }

    if (fields.length) {
      params.push(`fields=${fields.map(encodeURIComponent).join(',')}`);
    }

    const query = params.length ? `?${params.join('&')}` : '';
    const entities: Entity[] = await this.requestRequired(
      'GET',
      `/entities${query}`,
      options,
    );
    return { items: entities };
  }

  async getEntityByName(
    compoundName: EntityName,
    options?: CatalogRequestOptions,
  ): Promise<Entity | undefined> {
    const { kind, namespace = 'default', name } = compoundName;
    return this.requestOptional(
      'GET',
      `/entities/by-name/${encodeURIComponent(kind)}/${encodeURIComponent(
        namespace,
      )}/${encodeURIComponent(name)}`,
      options,
    );
  }

  async getAttachment(
    name: EntityName,
    key: string,
    options?: CatalogRequestOptions,
  ): Promise<CatalogAttachmentResponse> {
    return {
      blob: async () => {
        return await this.getAttachmentBlob(name, key, options);
      },
      text: async () => {
        const blob = await this.getAttachmentBlob(name, key, options);

        return blob ? await blob.text() : undefined;
      },
      url: async () => {
        if (options?.token) {
          // In case a token is used, we have to fallback to a workaround, as a
          // simple URL won't work with tokens provided in headers. This is less
          // efficient, but also only used in that case.
          // Instead of returning a URL where the caller can request the attachment
          // from, we return the attachment directly as a base64 URL. Returning blob
          // URLs might be more efficient, but requires to release them afterwards.
          const blob = await this.getAttachmentBlob(name, key, options);
          const reader = new FileReader();

          if (!blob) {
            throw new Error(
              `Error while requesting attachment URL, attachment with key ${key} on entity named ${stringifyEntityRef(
                name,
              )} not found`,
            );
          }

          return new Promise<string>((resolve, reject) => {
            reader.onload = e => {
              if (e.target && typeof e.target.result === 'string') {
                resolve(e.target.result);
              }
              reject(
                new Error(
                  `Unknown onload result while requesting attachment URL with key ${key} on entity named ${stringifyEntityRef(
                    name,
                  )}`,
                ),
              );
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }

        return await this.getAttachmentUrl(name, key);
      },
    };
  }

  async addLocation(
    { type = 'url', target, dryRun, presence }: AddLocationRequest,
    options?: CatalogRequestOptions,
  ): Promise<AddLocationResponse> {
    const response = await fetch(
      `${await this.discoveryApi.getBaseUrl('catalog')}/locations${
        dryRun ? '?dryRun=true' : ''
      }`,
      {
        headers: {
          'Content-Type': 'application/json',
          ...(options?.token && { Authorization: `Bearer ${options?.token}` }),
        },
        method: 'POST',
        body: JSON.stringify({ type, target, presence }),
      },
    );

    if (response.status !== 201) {
      throw new Error(await response.text());
    }

    const { location, entities } = await response.json();

    if (!location) {
      throw new Error(`Location wasn't added: ${target}`);
    }

    if (entities.length === 0) {
      throw new Error(
        `Location was added but has no entities specified yet: ${target}`,
      );
    }
    return {
      location,
      entities,
    };
  }

  async getOriginLocationByEntity(
    entity: Entity,
    options?: CatalogRequestOptions,
  ): Promise<Location | undefined> {
    const locationCompound =
      entity.metadata.annotations?.[ORIGIN_LOCATION_ANNOTATION];
    if (!locationCompound) {
      return undefined;
    }
    const all: { data: Location }[] = await this.requestRequired(
      'GET',
      '/locations',
      options,
    );
    return all
      .map(r => r.data)
      .find(l => locationCompound === stringifyLocationReference(l));
  }

  async getLocationByEntity(
    entity: Entity,
    options?: CatalogRequestOptions,
  ): Promise<Location | undefined> {
    const locationCompound = entity.metadata.annotations?.[LOCATION_ANNOTATION];
    if (!locationCompound) {
      return undefined;
    }
    const all: { data: Location }[] = await this.requestRequired(
      'GET',
      '/locations',
      options,
    );
    return all
      .map(r => r.data)
      .find(l => locationCompound === stringifyLocationReference(l));
  }

  async removeLocationById(
    id: string,
    options?: CatalogRequestOptions,
  ): Promise<void> {
    await this.requestIgnored(
      'DELETE',
      `/locations/${encodeURIComponent(id)}`,
      options,
    );
  }

  async removeEntityByUid(
    uid: string,
    options?: CatalogRequestOptions,
  ): Promise<void> {
    await this.requestIgnored(
      'DELETE',
      `/entities/by-uid/${encodeURIComponent(uid)}`,
      options,
    );
  }

  //
  // Private methods
  //

  private async getAttachmentUrl(
    name: EntityName,
    key: string,
  ): Promise<string> {
    const baseUrl = await this.discoveryApi.getBaseUrl('catalog');
    return `${baseUrl}/entities/by-name/${encodeURIComponent(
      name.kind,
    )}/${encodeURIComponent(name.namespace)}/${encodeURIComponent(
      name.name,
    )}/attachments/${encodeURIComponent(key)}`;
  }

  private async getAttachmentBlob(
    name: EntityName,
    key: string,
    options?: CatalogRequestOptions,
  ): Promise<Blob | undefined> {
    const url = await this.getAttachmentUrl(name, key);
    const response = await fetch(url, {
      headers: {
        ...(options?.token && {
          Authorization: `Bearer ${options?.token}`,
        }),
      },
    });

    if (response.status === 404) {
      return undefined;
    }

    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }

    return await response.blob();
  }

  private async requestIgnored(
    method: string,
    path: string,
    options?: CatalogRequestOptions,
  ): Promise<void> {
    const url = `${await this.discoveryApi.getBaseUrl('catalog')}${path}`;
    const headers: Record<string, string> = options?.token
      ? { Authorization: `Bearer ${options.token}` }
      : {};
    const response = await fetch(url, { method, headers });

    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }
  }

  private async requestRequired(
    method: string,
    path: string,
    options?: CatalogRequestOptions,
  ): Promise<any> {
    const url = `${await this.discoveryApi.getBaseUrl('catalog')}${path}`;
    const headers: Record<string, string> = options?.token
      ? { Authorization: `Bearer ${options.token}` }
      : {};
    const response = await fetch(url, { method, headers });

    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }

    return await response.json();
  }

  private async requestOptional(
    method: string,
    path: string,
    options?: CatalogRequestOptions,
  ): Promise<any | undefined> {
    const url = `${await this.discoveryApi.getBaseUrl('catalog')}${path}`;
    const headers: Record<string, string> = options?.token
      ? { Authorization: `Bearer ${options.token}` }
      : {};
    const response = await fetch(url, { method, headers });

    if (!response.ok) {
      if (response.status === 404) {
        return undefined;
      }
      throw await ResponseError.fromResponse(response);
    }

    return await response.json();
  }
}
