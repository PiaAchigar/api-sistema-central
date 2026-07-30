import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./crypto.service";

const KEY = "RJZ1R+iXHdhi8KdeoVKl/yRfhv6KKolZAdDpx8eAk0E=";
const OTHER_KEY = "AJWJU780npuX93A1PKVba6pCElW4Jnx42oC0+2IgYjE=";

describe("crypto.service", () => {
  it("encrypt → decrypt devuelve el texto original", async () => {
    const packed = await encrypt("access-token-secreto", KEY);
    expect(await decrypt(packed, KEY)).toBe("access-token-secreto");
  });

  it("dos encrypt del mismo texto dan ciphertexts distintos (IV aleatorio)", async () => {
    const a = await encrypt("mismo texto", KEY);
    const b = await encrypt("mismo texto", KEY);
    expect(a).not.toBe(b);
  });

  it("falla al descifrar con una master key distinta", async () => {
    const packed = await encrypt("secreto", KEY);
    await expect(decrypt(packed, OTHER_KEY)).rejects.toThrow();
  });

  it("falla si falta la master key", async () => {
    await expect(encrypt("x", undefined)).rejects.toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
  });

  it("falla si el ciphertext está corrupto", async () => {
    await expect(decrypt("no-es-base64-valido!!", KEY)).rejects.toThrow();
  });
});
