import { join } from 'path';
import http from 'http';
import {
  DefineEndpointsParams,
  MethodHandler,
  NextRestFrameworkConfig
} from '../types';
import { OpenAPIV3_1 } from 'openapi-types';
import {
  DEFAULT_ERRORS,
  NEXT_REST_FRAMEWORK_USER_AGENT,
  OPEN_API_VERSION,
  ValidMethod,
  VERSION
} from '../constants';
import merge from 'lodash.merge';
import { getJsonSchema, getSchemaKeys } from './schemas';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import isEqualWith from 'lodash.isequalwith';
import chalk from 'chalk';
import { NextApiRequest } from 'next';

export const getHTMLForSwaggerUI = ({
  headers,
  config: {
    openApiJsonPath,
    openApiYamlPath,
    swaggerUiPath,
    swaggerUiConfig: { title, description, faviconHref, logoHref } = {}
  }
}: {
  headers: http.IncomingHttpHeaders;
  config: NextRestFrameworkConfig;
}) => {
  const proto = headers['x-forwarded-proto'] ?? 'http';
  const host = headers.host;
  const url = `${proto}://${host}/${openApiYamlPath}`;

  return `<!DOCTYPE html>
  <html lang="en" data-theme="light">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title}</title>
      <meta
        name="description"
        content="${description}"
      />
      <link rel="icon" type="image/x-icon" href="${faviconHref}">
      <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@4.5.0/swagger-ui.css" />
      <link
        href="https://cdn.jsdelivr.net/npm/daisyui@2.46.0/dist/full.css"
        rel="stylesheet"
        type="text/css"
      />
      <script src="https://cdn.tailwindcss.com"></script>
    </head>

    <body class="min-h-screen flex flex-col items-center">
      <div class="navbar bg-base-200 flex justify-center px-5">
        <div class="max-w-7xl flex justify-between grow gap-5 h-24">
          <a>
            <img
              src="${logoHref}"
              alt="Logo"
              class="w-32"
            />
          </a>
          <p>v${VERSION}</p>
        </div>
      </div>

      <main class="max-w-7xl grow w-full">
        <div id="swagger-ui"></div>
      </main>

      <footer class="footer bg-base-200 p-5 flex justify-center">
        <div class="container max-w-5xl flex flex-col items-center text-md gap-5">
          <ul class="flex flex-col items-center">
            <li>
              <a
                class="link"
                href="https://next-rest-framework.vercel.app/"
                target="_blank"
              >
                Docs
              </a>
            </li>
            <li>
              <a
                class="link"
                href="https://github.com/blomqma/next-rest-framework"
                target="_blank"
              >
                GitHub
              </a>
            </li>
            <li>
              <a class="link" href="${openApiJsonPath}">OpenAPI JSON</a>
            </li>
            <li>
              <a class="link" href="${openApiYamlPath}">OpenAPI YAML</a>
            </li>
            <li>
              <a class="link" href="${swaggerUiPath}">Swagger UI</a>
            </li>
          </ul>
          <p class="text-center">
            Next REST Framework © ${new Date().getFullYear()}
          </p>
        </div>
      </footer>

      <script src="https://unpkg.com/swagger-ui-dist@4.5.0/swagger-ui-bundle.js" crossorigin></script>
      <script>
        window.onload = () => {
          window.ui = SwaggerUIBundle({
              url: '${url}',
              dom_id: '#swagger-ui',
          });
        };
      </script>
    </body>
  </html>`;
};

const getNestedApiRoutes = (basePath: string, dir: string): string[] => {
  const dirents = readdirSync(join(basePath, dir), { withFileTypes: true });

  const files = dirents.map((dirent) => {
    const res = join(dir, dirent.name);
    return dirent.isDirectory() ? getNestedApiRoutes(basePath, res) : res;
  });

  return files.flat();
};

// Generate the OpenAPI paths from the Next.js API routes.
const generatePaths = async ({
  config: { apiRoutesPath, openApiJsonPath, openApiYamlPath, swaggerUiPath },
  req: { headers }
}: {
  config: NextRestFrameworkConfig;
  req: NextApiRequest;
}): Promise<OpenAPIV3_1.PathsObject> => {
  const filterApiRoutes = (file: string) => {
    const isCatchAllRoute = file.includes('...');

    const isOpenApiJsonRoute =
      file === `${openApiJsonPath?.split('/').at(-1)}.ts`;

    const isOpenApiYamlRoute =
      file === `${openApiYamlPath?.split('/').at(-1)}.ts`;

    const isSwaggerUiRoute = file === `${swaggerUiPath?.split('/').at(-1)}.ts`;

    if (
      isCatchAllRoute ||
      isOpenApiJsonRoute ||
      isOpenApiYamlRoute ||
      isSwaggerUiRoute
    ) {
      return false;
    } else {
      return true;
    }
  };

  const basePath = join(process.cwd(), apiRoutesPath ?? '');

  const apiRoutes = getNestedApiRoutes(basePath, '')
    .filter(filterApiRoutes)
    .map((file) =>
      `/api/${file}`
        .replace(/\\/g, '/')
        .replace('/index', '')
        .replace('[', '{')
        .replace(']', '}')
        .replace('.ts', '')
    );

  let paths: OpenAPIV3_1.PathsObject = {};

  await Promise.all(
    apiRoutes.map(async (route) => {
      const proto = headers['x-forwarded-proto'] ?? 'http';
      const host = headers.host;
      const url = `${proto}://${host}${route}`;
      const controller = new AbortController();

      // Abort the request if it takes longer than 200ms.
      const abortRequest = setTimeout(() => {
        controller.abort();
      }, 200);

      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': NEXT_REST_FRAMEWORK_USER_AGENT
          },
          signal: controller.signal
        });

        clearTimeout(abortRequest);

        const data: {
          nextRestFrameworkPaths: Record<string, OpenAPIV3_1.PathItemObject>;
        } = await res.json();

        const isPathItemObject = (
          obj: unknown
        ): obj is OpenAPIV3_1.PathItemObject => {
          return (
            !!obj && typeof obj === 'object' && 'nextRestFrameworkPaths' in obj
          );
        };

        if (res.status === 200 && isPathItemObject(data)) {
          paths = { ...paths, ...data.nextRestFrameworkPaths };
        }
      } catch {
        // A user defined API route returned an error.
      }
    })
  );

  return paths;
};

// In prod use the existing openapi.json file - in development mode update it whenever the generated API spec changes.
export const getOrCreateOpenApiSpec = async ({
  config,
  req
}: {
  config: NextRestFrameworkConfig;
  req: NextApiRequest;
}) => {
  let specFileFound = false;

  try {
    const data = readFileSync(join(process.cwd(), 'openapi.json'));
    global.openApiSpec = JSON.parse(data.toString());
    specFileFound = true;
  } catch {}

  if (process.env.NODE_ENV !== 'production') {
    const paths = await generatePaths({ config, req });

    const newSpec = {
      ...config.openApiSpecOverrides,
      openapi: OPEN_API_VERSION,
      paths: merge(config.openApiSpecOverrides?.paths, paths)
    };

    if (!isEqualWith(global.openApiSpec, newSpec)) {
      if (!specFileFound) {
        console.info(
          chalk.yellowBright('No API spec found, generating openapi.json')
        );
      } else {
        console.info(
          chalk.yellowBright('API spec changed, regenerating openapi.json')
        );
      }

      writeFileSync(
        join(process.cwd(), 'openapi.json'),
        JSON.stringify(newSpec, null, 2) + '\n',
        null
      );

      if (!global.apiSpecGeneratedLogged) {
        console.info(chalk.green('API spec generated successfully!'));
      }

      global.openApiSpec = newSpec;
    } else if (!global.apiSpecGeneratedLogged) {
      console.info(chalk.green('API spec up to date, skipping generation.'));
    }

    global.apiSpecGeneratedLogged = true;
  }

  return global.openApiSpec;
};

export const defaultResponse: OpenAPIV3_1.ResponseObject = {
  description: DEFAULT_ERRORS.unexpectedError,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' }
        }
      }
    }
  }
};

export const isValidMethod = (x: unknown): x is ValidMethod =>
  Object.values(ValidMethod).includes(x as ValidMethod);

export const getPathsFromMethodHandlers = ({
  config,
  methodHandlers,
  route
}: {
  config: NextRestFrameworkConfig;
  methodHandlers: DefineEndpointsParams;
  route: string;
}) => {
  const { openApiSpecOverrides } = methodHandlers;
  const paths: OpenAPIV3_1.PathsObject = {};

  paths[route] = {
    ...openApiSpecOverrides
  };

  Object.keys(methodHandlers)
    .filter(isValidMethod)
    .forEach((_method) => {
      const { openApiSpecOverrides, tags, input, output } = methodHandlers[
        _method
      ] as MethodHandler;

      const method = _method.toLowerCase();

      let requestBodyContent: Record<string, OpenAPIV3_1.MediaTypeObject> = {};

      if (input?.body && input?.contentType) {
        const schema = getJsonSchema({ schema: input.body });

        requestBodyContent = {
          [input.contentType]: {
            schema
          }
        };
      }

      const generatedResponses = output?.reduce(
        (obj, { status, contentType, schema }) => {
          const responseSchema = getJsonSchema({ schema });

          return Object.assign(obj, {
            [status]: {
              content: {
                [contentType]: {
                  schema: responseSchema
                }
              }
            }
          });
        },
        {}
      );

      const generatedOperationObject: OpenAPIV3_1.OperationObject = {
        tags,
        requestBody: {
          content: requestBodyContent
        },
        responses: {
          ...generatedResponses,
          default: defaultResponse
        }
      };

      const pathParameters = route.match(/{([^}]+)}/g);
      if (pathParameters) {
        generatedOperationObject.parameters = pathParameters.map((param) => ({
          name: param.replace(/[{}]/g, ''),
          in: 'path',
          required: true
        }));
      }

      if (input?.query) {
        generatedOperationObject.parameters = [
          ...(generatedOperationObject.parameters ?? []),
          ...getSchemaKeys({
            schema: input.query
          }).map((key) => ({
            name: key,
            in: 'query'
          }))
        ];
      }

      paths[route] = {
        ...paths[route],
        [method]: merge(generatedOperationObject, openApiSpecOverrides)
      };
    });

  return paths;
};
