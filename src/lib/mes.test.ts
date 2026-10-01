import { describe, expect, it } from "vitest";
import { diasDelMes } from "./mes";

describe("diasDelMes", () => {
  it("un mes de 31 días", () => {
    const d = diasDelMes("2026-10");
    expect(d).toHaveLength(31);
    expect(d[0]).toBe("2026-10-01");
    expect(d[30]).toBe("2026-10-31");
  });

  it("febrero no bisiesto tiene 28", () => {
    expect(diasDelMes("2027-02")).toHaveLength(28);
  });

  it("febrero bisiesto tiene 29", () => {
    const d = diasDelMes("2028-02");
    expect(d).toHaveLength(29);
    expect(d[28]).toBe("2028-02-29");
  });

  it("un mes de 30 días", () => {
    expect(diasDelMes("2026-11")).toHaveLength(30);
  });
});
