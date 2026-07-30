import { describe, expect, it } from "vitest";
import {
  CHANNEL_TYPES,
  deriveStatus,
  isChannelType,
  putBodySchemaFor,
} from "./channels.schema";

describe("isChannelType", () => {
  it("acepta los 4 canales conocidos", () => {
    expect(CHANNEL_TYPES.every((c) => isChannelType(c))).toBe(true);
  });
  it("rechaza un canal desconocido", () => {
    expect(isChannelType("telegram")).toBe(false);
  });
});

describe("putBodySchemaFor", () => {
  it("acepta config válida de whatsapp", () => {
    const r = putBodySchemaFor("whatsapp").safeParse({
      isActive: true,
      config: { phoneNumber: "+54 9 11 1234" },
    });
    expect(r.success).toBe(true);
  });
  it("acepta config parcial (solo el requerido)", () => {
    const r = putBodySchemaFor("facebook").safeParse({
      isActive: false,
      config: { pageId: "p1" },
    });
    expect(r.success).toBe(true);
  });
  it("acepta config vacía (sin configurar todavía)", () => {
    const r = putBodySchemaFor("instagram").safeParse({ isActive: false, config: {} });
    expect(r.success).toBe(true);
  });
  it("rechaza smtpPort fuera de rango en email", () => {
    const r = putBodySchemaFor("email").safeParse({
      isActive: true,
      config: { fromAddress: "a@b.com", smtpPort: 99999 },
    });
    expect(r.success).toBe(false);
  });
  it("rechaza isActive faltante", () => {
    const r = putBodySchemaFor("whatsapp").safeParse({ config: {} });
    expect(r.success).toBe(false);
  });
});

describe("deriveStatus", () => {
  it("sin_configurar cuando falta el campo requerido", () => {
    expect(deriveStatus("whatsapp", {}, true)).toBe("sin_configurar");
    expect(deriveStatus("whatsapp", { phoneNumber: "  " }, true)).toBe("sin_configurar");
  });
  it("inactivo cuando está configurado pero isActive=false", () => {
    expect(deriveStatus("whatsapp", { phoneNumber: "+54 9" }, false)).toBe("inactivo");
  });
  it("activo cuando está configurado e isActive=true", () => {
    expect(deriveStatus("email", { fromAddress: "a@b.com" }, true)).toBe("activo");
  });
  it("null/undefined config → sin_configurar", () => {
    expect(deriveStatus("facebook", null, true)).toBe("sin_configurar");
  });
});

describe("putBodySchemaFor credentials (whatsapp)", () => {
  it("acepta sin credentials (edita config/isActive sin tocar secretos)", () => {
    const r = putBodySchemaFor("whatsapp").safeParse({ isActive: true, config: {} });
    expect(r.success).toBe(true);
  });
  it("acepta credentials completas", () => {
    const r = putBodySchemaFor("whatsapp").safeParse({
      isActive: true,
      config: {},
      credentials: {
        accessToken: "tok",
        phoneNumberId: "123",
        appSecret: "secret",
        verifyToken: "verify",
      },
    });
    expect(r.success).toBe(true);
  });
  it("rechaza credentials parciales (todo o nada)", () => {
    const r = putBodySchemaFor("whatsapp").safeParse({
      isActive: true,
      config: {},
      credentials: { accessToken: "tok" },
    });
    expect(r.success).toBe(false);
  });
  it("un canal sin integración real (facebook) no acepta credentials", () => {
    const r = putBodySchemaFor("facebook").safeParse({
      isActive: true,
      config: { pageId: "p1" },
      credentials: { accessToken: "tok" },
    });
    expect(r.success).toBe(false);
  });
});
