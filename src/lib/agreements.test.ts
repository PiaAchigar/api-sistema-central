import { describe, expect, it } from "vitest";
import { diffAgreements } from "./agreements";

describe("diffAgreements", () => {
  it("proveedora nueva → crea", () => {
    const r = diffAgreements([], [{ serviceProviderId: "a", paymentType: "fixed_per_service", rate: 8000 }]);
    expect(r.toCreate).toHaveLength(1);
    expect(r.toCloseProviderIds).toEqual([]);
  });

  it("proveedora quitada → cierra", () => {
    const r = diffAgreements(
      [{ serviceProviderId: "a", paymentType: "fixed_per_service", rate: 8000 }],
      [],
    );
    expect(r.toCreate).toEqual([]);
    expect(r.toCloseProviderIds).toEqual(["a"]);
  });

  it("tarifa cambiada → cierra el viejo y crea el nuevo", () => {
    const r = diffAgreements(
      [{ serviceProviderId: "a", paymentType: "fixed_per_service", rate: 8000 }],
      [{ serviceProviderId: "a", paymentType: "fixed_per_service", rate: 9000 }],
    );
    expect(r.toCloseProviderIds).toEqual(["a"]);
    expect(r.toCreate).toEqual([{ serviceProviderId: "a", paymentType: "fixed_per_service", rate: 9000 }]);
  });

  it("tipo de pago cambiado → cierra y crea", () => {
    const r = diffAgreements(
      [{ serviceProviderId: "a", paymentType: "fixed_per_service", rate: 8000 }],
      [{ serviceProviderId: "a", paymentType: "percentage", rate: 40 }],
    );
    expect(r.toCloseProviderIds).toEqual(["a"]);
    expect(r.toCreate).toHaveLength(1);
  });

  it("sin cambios → no toca nada", () => {
    const same = [{ serviceProviderId: "a", paymentType: "percentage", rate: 40 }];
    const r = diffAgreements(same, [{ serviceProviderId: "a", paymentType: "percentage", rate: 40 }]);
    expect(r.toCreate).toEqual([]);
    expect(r.toCloseProviderIds).toEqual([]);
  });

  it("mezcla: una nueva, una sin cambios, una quitada", () => {
    const current = [
      { serviceProviderId: "keep", paymentType: "percentage", rate: 40 },
      { serviceProviderId: "remove", paymentType: "fixed_per_service", rate: 5000 },
    ];
    const desired = [
      { serviceProviderId: "keep", paymentType: "percentage", rate: 40 },
      { serviceProviderId: "new", paymentType: "per_hour", rate: 3000 },
    ];
    const r = diffAgreements(current, desired);
    expect(r.toCreate).toEqual([{ serviceProviderId: "new", paymentType: "per_hour", rate: 3000 }]);
    expect(r.toCloseProviderIds).toEqual(["remove"]);
  });
});
