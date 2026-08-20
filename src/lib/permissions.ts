/** Permisos por rol y sección. FUENTE DE NEGOCIO: reglas_negocio.md §1.7.
 *  Editar ACÁ para cambiar accesos. Hay un espejo en
 *  front-dashboard/src/lib/permissions.ts — mantener ambos sincronizados. */

export type Role = "admin" | "manager" | "operator" | "sales" | "accountant";
export type Capability = "view" | "edit" | "manage"; // manage = crear + archivar
export type Section =
  | "agenda"
  | "facturacion"
  | "crm"
  | "crm-config"
  | "catalogo"
  | "proveedoras"
  | "sitio-web"
  | "config-local"
  | "usuarios"
  | "permisos";

export const PERMISSIONS: Record<Section, Record<Capability, Role[]>> = {
  agenda: {
    view: ["admin", "manager", "operator"],
    edit: ["admin", "manager", "operator"],
    manage: ["admin", "manager", "operator"],
  },
  facturacion: {
    view: ["admin", "manager", "operator", "accountant"],
    edit: ["admin", "manager", "operator"],
    manage: ["admin", "manager"],
  },
  // CRM = contactos, clientes y deals. §1.7: `F` para admin, manager, operator
  // y sales. La configuración del CRM NO vive acá — ver `crm-config`.
  crm: {
    view: ["admin", "manager", "operator", "sales"],
    edit: ["admin", "manager", "operator", "sales"],
    manage: ["admin", "manager", "operator", "sales"],
  },
  // Configuración del CRM: credenciales de IA, canales, automatizaciones y sus
  // FAQs. Es cableado del sistema, no trabajo con clientes, y por eso queda en
  // admin. Existe como sección propia porque antes se lograba lo mismo
  // recortando `crm.manage` a ["admin"], lo que le sacaba a sales el CRM que
  // §1.7 le da y dejaba las dos copias de este archivo desincronizadas.
  // Las LECTURAS de esas pantallas siguen en `crm:view` a propósito: ver qué
  // hay configurado no expone secretos (GET /credentials no devuelve la api_key).
  "crm-config": { view: ["admin"], edit: ["admin"], manage: ["admin"] },
  catalogo: {
    view: ["admin", "manager", "operator"],
    edit: ["admin", "manager", "operator"],
    manage: ["admin", "manager"],
  },
  proveedoras: {
    view: ["admin", "manager"],
    edit: ["admin", "manager"],
    manage: ["admin", "manager"],
  },
  "sitio-web": {
    view: ["admin", "manager", "operator"],
    edit: ["admin", "manager", "operator"],
    manage: ["admin", "manager"],
  },
  "config-local": { view: ["admin"], edit: ["admin"], manage: ["admin"] },
  usuarios: { view: ["admin"], edit: ["admin"], manage: ["admin"] },
  permisos: { view: ["admin"], edit: [], manage: [] },
};

export function can(
  role: Role | null | undefined,
  section: Section,
  cap: Capability,
): boolean {
  if (!role) return false;
  return PERMISSIONS[section][cap].includes(role as Role);
}
