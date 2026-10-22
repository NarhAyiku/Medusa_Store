import {
  getTenantRegistry,
  parseTenantRegistry,
  resetTenantRegistryCache,
} from "../store-tenants"

const SECRET_A = "a".repeat(40)
const SECRET_B = "b".repeat(40)

describe("parseTenantRegistry", () => {
  it("returns an empty registry when STORE_TENANTS is unset", () => {
    expect(parseTenantRegistry(undefined).size).toBe(0)
    expect(parseTenantRegistry("").size).toBe(0)
    expect(parseTenantRegistry("   ").size).toBe(0)
  })

  it("parses an object keyed by tenant id with defaults applied", () => {
    const registry = parseTenantRegistry(
      JSON.stringify({ eaglesneaglets: { secret: SECRET_A } })
    )

    expect(registry.get("eaglesneaglets")).toEqual({
      id: "eaglesneaglets",
      name: "eaglesneaglets",
      secret: SECRET_A,
      active: true,
      eventsUrl: null,
      eventsSecret: null,
    })
  })

  it("parses an array of tenants carrying an id", () => {
    const registry = parseTenantRegistry(
      JSON.stringify([
        {
          id: "eaglesneaglets",
          name: "Eagles & Eaglets",
          secret: SECRET_A,
          active: false,
          events_url: "https://platform.example/api/v1/store/events/",
          events_secret: "events-secret",
        },
      ])
    )

    expect(registry.get("eaglesneaglets")).toEqual({
      id: "eaglesneaglets",
      name: "Eagles & Eaglets",
      secret: SECRET_A,
      active: false,
      eventsUrl: "https://platform.example/api/v1/store/events/",
      eventsSecret: "events-secret",
    })
  })

  it("rejects invalid JSON", () => {
    expect(() => parseTenantRegistry("{not json")).toThrow(/not valid JSON/)
  })

  it("rejects tenant ids that are not lowercase slugs", () => {
    expect(() =>
      parseTenantRegistry(JSON.stringify({ "Eagles Eaglets": { secret: SECRET_A } }))
    ).toThrow(/tenant id/)
  })

  it("rejects secrets shorter than 32 characters", () => {
    expect(() =>
      parseTenantRegistry(JSON.stringify({ t1: { secret: "too-short" } }))
    ).toThrow(/at least 32 characters/)
  })

  it("rejects a tenant secret equal to a reserved Medusa secret", () => {
    expect(() =>
      parseTenantRegistry(JSON.stringify({ t1: { secret: SECRET_A } }), {
        reservedSecrets: [SECRET_A],
      })
    ).toThrow(/differ from Medusa's own/)
  })

  it("rejects two tenants sharing one secret", () => {
    expect(() =>
      parseTenantRegistry(
        JSON.stringify({ t1: { secret: SECRET_A }, t2: { secret: SECRET_A } })
      )
    ).toThrow(/shared with another tenant/)
  })

  it("rejects duplicate tenant ids in array form", () => {
    expect(() =>
      parseTenantRegistry(
        JSON.stringify([
          { id: "t1", secret: SECRET_A },
          { id: "t1", secret: SECRET_B },
        ])
      )
    ).toThrow(/more than once/)
  })

  it("requires events_secret when events_url is set", () => {
    expect(() =>
      parseTenantRegistry(
        JSON.stringify({
          t1: { secret: SECRET_A, events_url: "https://platform.example/events" },
        })
      )
    ).toThrow(/events_secret is required/)
  })
})

describe("getTenantRegistry", () => {
  afterEach(() => resetTenantRegistryCache())

  it("reads STORE_TENANTS from the environment and caches it", () => {
    const env = {
      STORE_TENANTS: JSON.stringify({ t1: { secret: SECRET_A } }),
      JWT_SECRET: "medusa-jwt",
      COOKIE_SECRET: "medusa-cookie",
    } as NodeJS.ProcessEnv

    const first = getTenantRegistry(env)
    const second = getTenantRegistry({ STORE_TENANTS: "" } as NodeJS.ProcessEnv)

    expect(first.has("t1")).toBe(true)
    expect(second).toBe(first)
  })

  it("refuses a tenant secret equal to JWT_SECRET", () => {
    const env = {
      STORE_TENANTS: JSON.stringify({ t1: { secret: SECRET_A } }),
      JWT_SECRET: SECRET_A,
    } as NodeJS.ProcessEnv

    expect(() => getTenantRegistry(env)).toThrow(/differ from Medusa's own/)
  })
})
