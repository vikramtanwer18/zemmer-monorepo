/**
 * OpenAPI 3.1 description of the public API (served at /api/public/v1/openapi.json, summarised in
 * docs/API_DESIGN.md). A unit test keeps it in step with apiLeadSchema's fields.
 */
export function publicApiDocument(serverUrl: string) {
  const error = {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: {
            type: "string",
            enum: [
              "AUTH_REQUIRED",
              "FORBIDDEN",
              "VALIDATION_FAILED",
              "CONFLICT",
              "ENTITLEMENT_REQUIRED",
              "RATE_LIMITED",
            ],
          },
          message: { type: "string" },
          fields: {
            type: "object",
            additionalProperties: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };
  const str = (maxLength: number, description?: string) => ({
    type: "string",
    maxLength,
    ...(description ? { description } : {}),
  });
  return {
    openapi: "3.1.0",
    info: {
      title: "Gym website enquiries API",
      version: "1.0.0",
      description:
        "Send enquiries from a gym's own website into its Leads. Each API key belongs to one gym and one branch; create and revoke keys in Settings → Leads → Website API. Keep keys on your server.",
    },
    servers: [{ url: serverUrl }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "gk_<prefix>_<secret>",
        },
      },
      schemas: { Error: error },
    },
    paths: {
      "/api/public/v1/leads": {
        post: {
          operationId: "createLead",
          summary: "Create a lead (or add a repeat enquiry to an open one)",
          description:
            "If an open lead with the same mobile or email exists, the enquiry is added to it (its latest touch is updated) and 200 is returned with created=false. Unknown fields are refused.",
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              description:
                "8–100 chars. A retry with the same key and body returns the first result (24 h); a different body → 409.",
              schema: {
                type: "string",
                minLength: 8,
                maxLength: 100,
                pattern: "^[A-Za-z0-9_.:-]+$",
              },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["first_name", "consent"],
                  description: "At least one of phone or email.",
                  properties: {
                    first_name: str(60),
                    last_name: str(60),
                    phone: str(
                      20,
                      "Indian mobile (10 digits) or +country format",
                    ),
                    email: str(200),
                    interest: str(300),
                    message: str(1000),
                    source: str(
                      60,
                      "A source code configured in the gym, e.g. website, instagram",
                    ),
                    campaign: str(
                      120,
                      "A campaign tracking code; otherwise utm_campaign is matched",
                    ),
                    utm_source: str(120),
                    utm_medium: str(120),
                    utm_campaign: str(120),
                    utm_term: str(120),
                    utm_content: str(120),
                    referrer: str(300),
                    consent: {
                      type: "object",
                      additionalProperties: false,
                      required: ["given", "text"],
                      properties: {
                        given: {
                          type: "boolean",
                          const: true,
                          description: "The person ticked the consent box",
                        },
                        text: {
                          type: "string",
                          minLength: 10,
                          maxLength: 500,
                          description: "The exact consent text they saw",
                        },
                        marketing: {
                          type: "boolean",
                          description: "They also agreed to offers",
                        },
                      },
                    },
                  },
                },
                example: {
                  first_name: "Asha",
                  phone: "9876543210",
                  interest: "Morning yoga",
                  utm_source: "instagram",
                  utm_campaign: "diwali-2026",
                  consent: {
                    given: true,
                    text: "I agree that Iron Temple may contact me about my enquiry.",
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Lead created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string", format: "uuid" },
                      created: { const: true },
                    },
                  },
                },
              },
            },
            "200": {
              description:
                "Added to an existing open lead, or an idempotent replay",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string", format: "uuid" },
                      created: { type: "boolean" },
                      replayed: { type: "boolean" },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Not JSON",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "401": {
              description: "Missing, wrong or revoked key",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "402": {
              description: "The gym's plan doesn't include leads",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "403": {
              description: "The key lacks the leads.create scope",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "409": {
              description: "Idempotency-Key reused with a different body",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "422": {
              description: "Invalid fields",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "429": {
              description: "Rate limited (Retry-After header)",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
    },
  };
}
