import { describe, expect, it } from "vitest";
import { buildPublicActivity } from "./activities-public";

describe("buildPublicActivity", () => {
  it("expone solo los campos públicos y deja afuera la proveedora", () => {
    const row = {
      id: "a1", name: "Pilates Reformer - Abono mensual 1 vez por semana",
      description: null, activityType: "class", classesPerMonth: 4,
      monthlyBasePrice: "52000.00", serviceProviderId: "prov-1", isActive: true,
    };
    const out = buildPublicActivity(row);
    expect(out).toEqual({
      id: "a1", name: "Pilates Reformer - Abono mensual 1 vez por semana",
      description: null, activityType: "class", classesPerMonth: 4,
      monthlyBasePrice: "52000.00",
    });
    expect(out).not.toHaveProperty("serviceProviderId");
  });
});
