import { describe, expect, it } from "vitest";
import { PERMISSIONS, can, type Role, type Section } from "./permissions";

describe("can() — matriz §1.7", () => {
  it("admin puede gestionar todo el catálogo", () => {
    expect(can("admin", "catalogo", "manage")).toBe(true);
  });
  it("manager gestiona catálogo (crear/archivar)", () => {
    expect(can("manager", "catalogo", "manage")).toBe(true);
  });
  it("operator edita catálogo pero NO gestiona", () => {
    expect(can("operator", "catalogo", "edit")).toBe(true);
    expect(can("operator", "catalogo", "manage")).toBe(false);
  });
  it("operator NO accede a proveedoras", () => {
    expect(can("operator", "proveedoras", "view")).toBe(false);
  });
  it("manager gestiona proveedoras", () => {
    expect(can("manager", "proveedoras", "manage")).toBe(true);
  });
  it("sales solo CRM", () => {
    expect(can("sales", "crm", "manage")).toBe(true);
    expect(can("sales", "catalogo", "view")).toBe(false);
    expect(can("sales", "facturacion", "view")).toBe(false);
  });
  it("accountant solo ve facturación", () => {
    expect(can("accountant", "facturacion", "view")).toBe(true);
    expect(can("accountant", "facturacion", "edit")).toBe(false);
    expect(can("accountant", "crm", "view")).toBe(false);
  });
  it("config-local y usuarios: solo admin", () => {
    expect(can("manager", "config-local", "view")).toBe(false);
    expect(can("manager", "usuarios", "view")).toBe(false);
    expect(can("admin", "config-local", "manage")).toBe(true);
  });
  it("rol nulo nunca puede", () => {
    expect(can(null, "agenda", "view")).toBe(false);
  });
});

describe("crm-config — configuración del CRM, separada del CRM", () => {
  it("solo admin la toca", () => {
    for (const rol of ["manager", "operator", "sales", "accountant"] as const) {
      expect(can(rol, "crm-config", "manage")).toBe(false);
      expect(can(rol, "crm-config", "view")).toBe(false);
    }
    expect(can("admin", "crm-config", "manage")).toBe(true);
  });

  it("restringirla NO le saca a nadie el CRM de §1.7", () => {
    // Es exactamente lo que había pasado: para dejar los canales en admin se
    // recortó `crm.manage`, y sales perdió el CRM que la regla le da.
    for (const rol of ["admin", "manager", "operator", "sales"] as const) {
      expect(can(rol, "crm", "manage")).toBe(true);
    }
  });
});


/**
 * La matriz de reglas_negocio.md §1.7, transcrita tal cual. La misma tabla está
 * en front-dashboard/src/lib/permissions.test.ts: cada copia de
 * `permissions.ts` se verifica contra el documento por separado, así que si una
 * de las dos se desvía, falla sola. Es lo que faltaba en julio, cuando el
 * backend recortó `crm.manage` y el front quedó atrás sin que nada avisara.
 *
 * Niveles: F = completo · E = ver + editar · V = solo ver · – = sin acceso.
 */
const MATRIZ_1_7: Record<Section, Record<Role, "F" | "E" | "V" | "–">> = {
  agenda:          { admin: "F", manager: "F", operator: "F", sales: "–", accountant: "–" },
  facturacion:     { admin: "F", manager: "F", operator: "E", sales: "–", accountant: "V" },
  crm:             { admin: "F", manager: "F", operator: "F", sales: "F", accountant: "–" },
  // No es una fila de §1.7: es cableado del sistema (credenciales de IA,
  // canales, automatizaciones), y por eso admin sola.
  "crm-config":    { admin: "F", manager: "–", operator: "–", sales: "–", accountant: "–" },
  catalogo:        { admin: "F", manager: "F", operator: "E", sales: "–", accountant: "–" },
  proveedoras:     { admin: "F", manager: "F", operator: "–", sales: "–", accountant: "–" },
  "sitio-web":     { admin: "F", manager: "F", operator: "E", sales: "–", accountant: "–" },
  "config-local":  { admin: "F", manager: "–", operator: "–", sales: "–", accountant: "–" },
  usuarios:        { admin: "F", manager: "–", operator: "–", sales: "–", accountant: "–" },
  permisos:        { admin: "V", manager: "–", operator: "–", sales: "–", accountant: "–" },
};

const SECCIONES = Object.keys(MATRIZ_1_7) as Section[];
const ROLES: Role[] = ["admin", "manager", "operator", "sales", "accountant"];

/** Nivel efectivo de un rol en una sección, derivado de `can()`. Se calcula acá
 *  y no con un helper de producción: `levelFor()` es de la tabla de permisos
 *  del dashboard y el backend no la dibuja. */
function nivel(seccion: Section, rol: Role): "F" | "E" | "V" | "–" {
  if (can(rol, seccion, "manage")) return "F";
  if (can(rol, seccion, "edit")) return "E";
  if (can(rol, seccion, "view")) return "V";
  return "–";
}

describe("PERMISSIONS respeta la matriz de reglas_negocio.md §1.7", () => {
  for (const seccion of SECCIONES) {
    for (const rol of ROLES) {
      const esperado = MATRIZ_1_7[seccion][rol];
      it(`${seccion} / ${rol} → ${esperado}`, () => {
        expect(nivel(seccion, rol)).toBe(esperado);
      });
    }
  }

  it("la matriz cubre exactamente las secciones declaradas", () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual(SECCIONES.slice().sort());
  });

  it("quien gestiona también edita, y quien edita también ve", () => {
    // Un rol con `manage` pero sin `view` haría que el front le esconda la
    // sección y el backend le acepte igual el POST.
    for (const seccion of SECCIONES) {
      const p = PERMISSIONS[seccion];
      for (const rol of p.manage) expect(p.edit).toContain(rol);
      for (const rol of p.edit) expect(p.view).toContain(rol);
    }
  });
});
