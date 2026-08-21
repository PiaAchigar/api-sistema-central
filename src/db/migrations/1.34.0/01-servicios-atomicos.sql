-- ════════════════════════════════════════════════════════════════════════════
-- 1.34.0 / 01 — Servicios atómicos: sacar los combos del catálogo de Servicios
-- ════════════════════════════════════════════════════════════════════════════
-- APLICADA EN PRODUCCIÓN el 2026-08-21.
--
-- `service` mezclaba tres cosas: servicios de verdad (una zona, un precio, un
-- turno), combos cargados como si fueran un servicio suelto, y —además— el
-- MISMO combo cargado otra vez como promoción. 63 de los combos estaban
-- duplicados en las dos tablas, con el mismo nombre.
--
-- Esta migración deja en `service` solo la unidad atómica. Los paquetes pasan a
-- vivir en la pestaña Combos, con su precio propio.
--
--   servicios activos  213 → 149
--   promociones         65 → 0
--   promos vacías web   15 → 0
--
-- LA CLASIFICACIÓN LA HIZO LAURA, no una regla automática. Ninguna heurística
-- separaba los casos: `PRP - Facial, Cuello y Escote` es un combo y `Biopsia con
-- Extracción y Estudio Patológico` es un servicio, y las dos frases tienen la
-- misma forma. Se le pasó una planilla (`planning/revision_catalogo.csv`) con los
-- 213 servicios activos y las 65 promociones, ordenada por prioridad; ella marcó
-- una por una las 37 ambiguas y el resto quedó con la propuesta del sistema.
-- Por eso acá se borra por ID explícito y no con LIKE: cada uno de estos
-- 129 registros es uno que alguien miró.
--
-- Tres decisiones suyas sobre casos que se le marcaron aparte:
--   · IPL y LUZ PULSADA INTENSA eran el mismo tratamiento cargado dos veces con
--     el mismo precio ($62.000, $102.000 y $167.000 se repiten en los dos
--     nombres). Quedan las de IPL; las de LUZ PULSADA se borran como duplicados
--     y NO se rearman como combos. Se sumó `LUZ PULSADA INTENSA - Sesion Facial`,
--     que no estaba en la planilla porque su nombre no disparaba ningún filtro,
--     pero es duplicado exacto de `IPL Rostro - Sesión`. Sobrevive a propósito
--     `LUZ PULSADA INTENSA - En MANOS // AXILAS`: no tiene par en IPL.
--   · Las de `Radiofrecuencia Facial` quedan como servicio: son limpieza facial
--     con radiofrecuencia, no un paquete de zonas. Por el mismo criterio quedan
--     las dos de `Radiofrecuencia Fraccionada`.
--   · `Retiro de esmalte semi de manos y pies` queda como servicio: es un
--     recargo, no un paquete.
--
-- ANTES DE BORRAR se volcaron nombre, descripción y precio de cada combo a
-- `planning/combos_a_cargar.md` (75 combos, 59 con precio). Esa es la lista de
-- precios de Laura y es lo único que estos registros tenían de valioso.
--
-- OJO: `promotions` queda VACÍA. Las 65 filas eran todas `promotion_type='bundle'`
-- sin importe: combos duplicados, no promociones con descuento.
--
-- ── POR QUÉ UN SOLO BLOQUE DO Y NO TABLAS TEMPORALES ────────────────────────
-- La primera versión usaba `CREATE TEMP TABLE ... ON COMMIT DROP` y falló en el
-- SQL Editor de Supabase con:
--     ERROR: 42P01: relation "_serv_borrar" does not exist
-- El editor hace autocommit por sentencia, así que la temporal se creaba y se
-- destruía en el acto y las sentencias siguientes no la encontraban — dejando la
-- migración a medio aplicar. Un único bloque DO es una sola sentencia: corre
-- entero o no corre, y mantiene el orden de borrado que las FK necesitan.
-- Tampoco usa `\echo`, que es un meta-comando de psql y el editor no entiende.
--
-- Idempotente: borrar IDs que ya no existen no hace nada.

DO $$
DECLARE
  serv uuid[] := ARRAY[
    'a3f0f083-0862-42a5-929f-9f393fb4f6a5',  -- Abdomen y Pecho
    'cb28053b-fd75-467f-a431-4f8c1b1cb611',  -- Alpha Synergy - Combo Zona Inferior
    '21e68820-849e-4044-a675-7dddc2e67a54',  -- Cavado y Axila / Bozo / Tira de cola
    '176eb6b7-8e40-4f3c-a95b-a720dfd5eb50',  -- Crio-Radiofrecuencia - Combo Zona Inferior
    '34265fca-53f0-4dfe-a44a-594ca54e36d3',  -- Cuerpo Completo Hombre (cod 317)
    '1bc22c46-599e-49ce-8f8e-d23c9f4bb82c',  -- Cuerpo Full Hombre (Promo más pedida)
    '05487c42-926f-47ec-a3b7-a8c34c1eadca',  -- Glúteos y Pelvis
    '377578bf-7387-4af1-916b-9446b212e61f',  -- Glúteos y Tira de cola
    'ca5d8573-45fc-48e8-9b41-8f8140d804e4',  -- LUZ PULSADA INTENSA - Pack 3 Facial
    '198ea508-7c18-4219-bd5a-baad1e9ce5e5',  -- Vela Slim Plus/Max - Combo Zona Inferior
    '460aef2f-43a7-4e3d-8331-b61bd83855a7',  -- Venus Legacy - Combo Zona Inferior
    '1356f433-b385-41a8-a27d-4366471b406f',  -- Alidya - Mesoterapia Anticelulítica, 2 Zonas
    '30cf16b8-24a3-4d30-8751-5d64883d3853',  -- Cavado / Pelvis completa (sin tira de cola)
    '66571328-69a9-4b85-b778-e748f7246861',  -- Limpieza de Cutis Premium + Masajes Faciales
    'c7cf8512-bad0-4aed-9b96-a256e8d3d04e',  -- LUZ PULSADA INTENSA -  Sesión Facial + cuello, escote y ma
    '8b7e16b1-8ef8-4646-b0b8-8cdbdcffc01b',  -- LUZ PULSADA INTENSA - Sesión Facial + cuello y escote.
    'ecb418cd-55dd-4e2d-9130-5c7329ef749a',  -- PRP - Facial y Capilar
    'ac65fa50-ef02-4f8f-8e04-47a26eaf4e23',  -- PRP - Facial, Cuello y Escote
    '65586608-57c7-402d-a858-a533245cf7bc',  -- PRP - Facial, Cuello, Escote y Capilar/Manos
    'a9ad90e3-37c9-4dfe-a204-cf20749cf2e7',  -- Abdomen, Pecho y Espalda Completa
    '935bd501-a9c8-4dc5-9baf-5da5a80e3f48',  -- Abdomen, Pecho y Pelvis completa
    'ab097d14-82b3-46f0-b22c-2058f21901c4',  -- Axila, Cavado completo y Bozo o Tira de cola
    '9d79b899-de9a-43fc-8f53-f13cea2aff90',  -- Cavado total, Axila, Bozo y Tira de cola (promo)
    'c81281f3-922d-4356-afb5-df19ec7af27e',  -- Cavado, Axila, Abdomen o Rostro completo
    '094fe727-ccb4-4f88-8c28-463f7e1c09ed',  -- Combo Cuerpo Full + 1 zona a elección (cod 438)
    'a0bef46d-bcd5-44ff-9648-ec745ad57b38',  -- Combo Cuerpo Full + Rostro Mujer (sesión suelta promo)
    '193c0951-a913-4dd9-a72b-445ed1371da9',  -- Combo Total Cuerpo + Rostro Completo (cod 575)
    '7182aa6f-9615-4ea1-9c1d-dd08175a081d',  -- Cuerpo Full + Rostro + Glúteos + 1 zona (cod 626)
    '8ddb1d2c-7c3e-497b-abcc-8a751dd05846',  -- Espalda completa + Hombros + Brazos + Pecho + Abdomen (axi
    '4c6a6a16-6ce7-4bfd-aaff-161bc7278a7a',  -- Espalda completa, Pecho y Hombros (Hombre)
    'cc122b55-f320-41c7-9ed9-5d00aac93610',  -- Glúteos, Pelvis y Tira de cola
    '812e4209-f63d-4c0c-918a-c1d532737575',  -- Pierna entera, Abdomen, Brazos, Pelvis, Tira de cola y Axi
    '5c8a3549-d2de-44bd-befd-e336a7d8b47c',  -- Pierna entera, Abdomen, Pecho y Brazo completo
    'a39a294b-a02d-4bde-af25-72da336ff23e',  -- Pierna entera, Axila, Cavado total, Tira de cola y Glúteos
    '7c7130b7-bb58-4c88-9dca-55a28c297a55',  -- Pierna entera, Cavado completo, Axila, Tira de cola y Bozo
    'bbeb35d7-12a4-414f-ab95-b8a2d9114e4b',  -- Pierna entera, Cavado completo, Axila, Tira de cola y Bozo
    'fae5a49e-bb95-4c4f-a1c1-ff2067e7be58',  -- Pierna entera, Cavado completo, Rostro completo y Axila o 
    'dd0f6402-be2a-407f-bdfa-712934a9736d',  -- Pierna entera, Cavado y Rostro completo
    'ad0aa274-59d8-4c22-8f1b-e6d266c5d590',  -- Pierna entera, Cavado, Axilas y Bozo o Tira de cola
    '3205d84f-5f3c-4fad-bdb4-453701c4cf2b',  -- Pierna entera, cavado, tira de cola, rostro completo, axil
    '6da1cf64-780a-4ee4-96b5-7a4d37fe5551',  -- Pierna entera, Espalda alta y baja y Pecho
    '3ec1f65c-9b19-4ca3-997e-d85643a7c353',  -- Pierna entera, Espalda alta y baja, Pelvis, Pecho
    'e9d89c35-a140-4bde-9de3-3d513800d024',  -- Pierna entera, Espalda alta y Pecho
    'fba90ea0-f0c0-43d3-9627-d71b6497a8b8',  -- Pierna entera, Espalda alta, Pelvis, Pecho
    '699ee2d0-6f22-4949-862d-967c057b1ea8',  -- Pierna entera, Pecho, Abdomen, Barba, Pelvis
    '2305aee9-ee66-4119-b38d-2815683fa418',  -- Pierna entera, Pecho, Barba, Pelvis y Glúteos
    'a062129d-0e98-4b60-b89b-e3b511f845d4',  -- Pierna entera, Pelvis y Axila
    'a4b74ffc-3c11-43f9-b404-0fa1c588e55f',  -- Pierna entera, Pies, Glúteos y Pelvis
    '1ce567be-1a32-4261-86b6-0d62061d2b3c',  -- Pierna entera, Rostro completo, Axila, Cavado y Tira de co
    '440bd049-6ae3-486a-b66c-a5675aa0188f',  -- Pierna Entera, Tira de cola, Cavado y Glúteos
    'b54038ec-4cdf-48da-b8fd-1ca6d9b09f7f',  -- PRP - Promo 2 Zonas Corporales
    'a30f262e-801c-4d14-8caa-42f9a8e9e7ca',  -- PRP - Promo Facial + Corporal
    'acf66bf0-6da5-41c3-801c-2cf9ca2763d5',  -- PRP con Dermapen - Promo 2 Zonas Corporales
    '88c14203-bf07-441e-b8f3-33a8c8958aeb',  -- PRP con Dermapen - Promo Facial + Corporal
    '0c891bd0-aff0-40af-a714-2d25f5d31f4c',  -- Reflexología
    '5366ed60-f06a-428e-aae4-192e54c482aa',  -- Rostro completo + Pelvis
    '6c917132-dcfa-46de-a310-57acd74d2c2b',  -- Rostro Completo y Axila
    'fe2008d0-6cf6-47ab-ba82-7c04a5256dde',  -- Rostro completo, Cavado y Antebrazo
    '873c38db-b28c-4cb3-af6e-3e975602d64e',  -- Rostro Completo, Cavado y Axila
    'cabba1be-a489-4289-a78b-0c8fb30d57ba',  -- Rostro completo, Cavado, Tira de cola y Axila
    '46b44883-14d6-4528-bcbd-2bbc1d030133',  -- Rostro, Cavado, Axilas, Tira de cola, Brazos y Espalda baj
    '32e8dc86-7e5d-4cae-846e-dbea9d4a259c',  -- Vela Slim Plus/Max - Combo Zona Superior / Piernas complet
    '9a1fea52-abf0-46f4-baef-c42e9826fcbf',  -- Venus Legacy - Combo Zona Superior / Piernas completas
    '5a8f65ff-6a71-4941-abc2-72ab021d9753'  -- LUZ PULSADA INTENSA - Sesion Facial
  ];
  promo uuid[] := ARRAY[
    '4cb40758-eedb-4d0e-8e66-9037a54b2bd5',  -- 1/2 Brazo + Cavado completo, Tira de cola, Axila y Bozo
    'bff0ae26-a397-4389-ab59-2d37edf17039',  -- 1/2 Pierna y Axila / Bozo / Cavado
    '60a3089d-2710-4b51-8339-09811c544b01',  -- 1/2 Pierna, Cavado total, Axila y Tira de cola o Bozo
    '591b5233-32e7-40aa-9eb6-6c913620b878',  -- 1/2 Pierna, Cavado total, Axila, Tira de cola y Bozo
    '5521c5b0-6644-463d-b1e9-4f151fd737e6',  -- 1/2 Pierna, Cavado total, Tira de cola y Glúteos
    '0bbbee8c-7228-47e1-a53f-74509fba3e08',  -- 1/2 Pierna, Cavado y Axila
    'f339e4ed-eb91-4804-871b-80fb13902a94',  -- Abdomen y Pecho
    'ff05cf7c-e1aa-4847-91f5-4f595cf59179',  -- Abdomen, Pecho y Espalda Completa
    '6bdb47b9-5091-4d65-8a05-73b19327e5cf',  -- Abdomen, Pecho y Pelvis completa
    '92266b9e-3d62-489d-b70f-d722486849ad',  -- Alpha Synergy - Combo Zona Inferior
    '2a0fa895-5b50-42d2-b632-ca01a3937631',  -- Alpha Synergy - Combo Zona Superior / Piernas completas
    'a01955da-67ff-4766-9726-908ad06554ea',  -- Axila, Brazo completo y Pierna entera
    '14119862-3161-405b-8839-10c3fca93b0c',  -- Axila, Cavado completo y Bozo o Tira de cola
    'fa4fb3dc-a395-4913-b6f6-fc7522e7967a',  -- Brazo completo y Pierna entera
    'cfec2682-945b-4dcd-a831-7d01cdfae66d',  -- Cavado total, Axila, Bozo y Tira de cola (promo)
    '7a421b26-0e44-4327-920f-df1cb2b7885a',  -- Cavado y Axila / Bozo / Tira de cola
    '6ca7243c-d9c5-486a-a640-c142f4c94c7c',  -- Cavado, Axila, Abdomen o Rostro completo
    '375dc544-7527-4f9f-9d9d-001c27909c23',  -- Combo Cuerpo Full + 1 zona a elección (cod 438)
    '24064a4e-58ff-4e28-99cf-4af476e49196',  -- Combo Cuerpo Full + Rostro Mujer (sesión suelta promo)
    '90294809-a929-42c6-be13-5e81c24e2b7d',  -- Combo Total Cuerpo + Rostro Completo (cod 575)
    'e2dfc449-4c15-4bfd-b93a-0b9c01a35fc0',  -- Crio-Radiofrecuencia - Combo Zona Inferior
    'a462ec99-43f3-4988-a00b-ca66c66e536f',  -- Crio-Radiofrecuencia - Combo Zona Superior / Piernas compl
    '7b1bde55-2f7c-46dd-8ab8-c2d887f2ff6e',  -- Cuerpo Completo Hombre (cod 317)
    '1c3061ce-c0ad-414b-9704-85d47d18ad39',  -- Cuerpo Full + Rostro + Glúteos + 1 zona (cod 626)
    '4ab9168f-6863-4d31-a33c-ad7bb3e88f72',  -- Cuerpo Full Hombre (Promo más pedida)
    'fb7b4476-0627-4695-aca3-f9438588f314',  -- Espalda completa + Hombros + Brazos + Pecho + Abdomen (axi
    'd96d9b02-bdf0-488b-b16f-8fffdddcee0b',  -- Espalda completa, Pecho y Hombros (Hombre)
    '9d0ac561-fac7-4320-80a8-fde3b9e90b09',  -- Glúteos y Pelvis
    '9b1b0f43-6956-4223-8f0b-c1779400fe7e',  -- Glúteos y Tira de cola
    '9ff55f0c-62e4-46bd-bbb3-b544c9da3d7d',  -- Glúteos, Pelvis y Tira de cola
    '2efcabc5-5c4f-41be-8bac-b8967eaef2f9',  -- Media Pierna, Cavado y Rostro completo
    '231b75c8-4f69-4d84-818f-979912858caa',  -- Pierna entera y Axila / Bozo / Cavado
    'fa29b41a-1c1d-40f3-b740-b1921ebe03d9',  -- Pierna entera y Glúteos
    'd73f5194-bcb2-4a61-994c-63f1d19e1dff',  -- Pierna entera y Glúteos (cod 540)
    '98ee521d-bf76-4309-9b0b-0525a13858a1',  -- Pierna entera, Abdomen y Pecho (cod 607)
    'f3e1d803-2e57-41d4-83af-221265e4235b',  -- Pierna entera, Abdomen y Pecho (promo hombre)
    'be1db2b7-fd95-47b9-805b-55dc6e82b150',  -- Pierna entera, Abdomen, Brazos, Pelvis, Tira de cola y Axi
    'f18752c9-e454-4f79-8c2b-02d1f7712432',  -- Pierna entera, Abdomen, Pecho y Brazo completo
    '5e8ce72e-7b57-4dc6-978a-c19247b90c56',  -- Pierna entera, Axila, Cavado total, Tira de cola y Glúteos
    'ecb3b2f5-9c55-4bb0-9c42-a63934b3a9eb',  -- Pierna entera, Cavado completo, Axila, Tira de cola y Bozo
    '5f08d39c-6105-48f1-817d-1d9a12a7df2a',  -- Pierna entera, Cavado completo, Axila, Tira de cola y Bozo
    '25bfbeb5-58d4-4e19-938c-87c0b9376f37',  -- Pierna entera, Cavado completo, Rostro completo y Axila o 
    'bd40fc7b-4ee8-4ba4-b995-be487448663b',  -- Pierna entera, Cavado y Rostro completo
    '04d92336-00e1-4726-807d-858a77caa7ee',  -- Pierna entera, Cavado, Axilas y Bozo o Tira de cola
    'b066d999-e7dc-43ff-8e2b-789596977c47',  -- Pierna entera, cavado, tira de cola, rostro completo, axil
    'e89fa5d3-72ea-4c30-b1de-551a9b55bdc3',  -- Pierna entera, Espalda alta y baja y Pecho
    '653c494f-1dcd-463a-b240-6ed690d031b1',  -- Pierna entera, Espalda alta y baja, Pelvis, Pecho
    '63844192-149f-410c-924e-d99fc9976018',  -- Pierna entera, Espalda alta y Pecho
    'c04d1828-8cb5-4673-a2de-0ecbf47d28f3',  -- Pierna entera, Espalda alta, Pelvis, Pecho
    '6efbdba7-08aa-436b-8563-1412aabe83b5',  -- Pierna entera, Pecho, Abdomen, Barba, Pelvis
    'db249651-90cd-471e-bb15-9eac500ee86d',  -- Pierna entera, Pecho, Barba, Pelvis y Glúteos
    'ecbe60aa-5df8-4428-a04f-1711a1c59d60',  -- Pierna entera, Pelvis y Axila
    '6e7fe0d6-17b8-4310-a932-003719a90421',  -- Pierna entera, Pies, Glúteos y Pelvis
    '32c4e4ec-4f95-497d-9fd0-89f9709c9c51',  -- Pierna entera, Rostro completo, Axila, Cavado y Tira de co
    '5b259685-f54c-4584-86c0-8c4b4714be9b',  -- Pierna Entera, Tira de cola, Cavado y Glúteos
    'd14371f5-bac7-419c-a86e-68c67c2d45a3',  -- Rostro completo + Pelvis
    'ea04e2ec-dac3-4f4b-86c6-46f75d6881eb',  -- Rostro Completo y Axila
    'de3efb9d-1428-435e-91a3-02830a0b8283',  -- Rostro completo, Cavado y Antebrazo
    'ee234888-2e50-4215-bf3c-05c5c3655861',  -- Rostro Completo, Cavado y Axila
    'a1225721-df37-4009-9f6f-d69b41126bb5',  -- Rostro completo, Cavado, Tira de cola y Axila
    '86ff2c21-1abe-4f4d-872e-672d80abb088',  -- Rostro, Cavado, Axilas, Tira de cola, Brazos y Espalda baj
    '1031057a-2654-4a3f-94fc-c7fb3536aa8f',  -- Vela Slim Plus/Max - Combo Zona Inferior
    '4c3a2d2a-f95e-47bf-95e7-9e55b3bf5c7a',  -- Vela Slim Plus/Max - Combo Zona Superior / Piernas complet
    'b39ddc40-e142-482a-bf7f-7b340a85bc8e',  -- Venus Legacy - Combo Zona Inferior
    'cab662cb-2534-4202-b204-69503395868b'  -- Venus Legacy - Combo Zona Superior / Piernas completas
  ];
  n int;
BEGIN
  -- Guardas: si alguno tuviera historial, aborta antes de tocar nada.
  SELECT count(*) INTO n FROM appointments WHERE service_id = ANY(serv);
  IF n > 0 THEN RAISE EXCEPTION 'ABORTA: % turnos apuntan a servicios a borrar', n; END IF;
  SELECT count(*) INTO n FROM line_items   WHERE service_id = ANY(serv);
  IF n > 0 THEN RAISE EXCEPTION 'ABORTA: % lineas de factura apuntan a servicios a borrar', n; END IF;
  SELECT count(*) INTO n FROM combo_service WHERE service_id = ANY(serv);
  IF n > 0 THEN RAISE EXCEPTION 'ABORTA: % lineas de combo apuntan a servicios a borrar', n; END IF;

  RAISE NOTICE 'ANTES: % servicios activos, % promociones',
    (SELECT count(*) FROM service WHERE is_active), (SELECT count(*) FROM promotions);

  -- Hijas de promotions
  DELETE FROM promotion_service  WHERE promotion_id = ANY(promo);
  DELETE FROM promotion_product  WHERE promotion_id = ANY(promo);

  -- Hijas de service. `promotion_service` aparece otra vez por si una promoción
  -- que se queda apuntara a un servicio que se va; hoy son 0, pero no se asume.
  DELETE FROM promotion_service        WHERE service_id = ANY(serv);
  DELETE FROM service_category         WHERE service_id = ANY(serv);
  DELETE FROM service_machine          WHERE service_id = ANY(serv);
  DELETE FROM service_provider_service WHERE service_id = ANY(serv);

  -- Los registros. `service_embeddings` cae solo (ON DELETE CASCADE); el resto
  -- de las hijas es NO ACTION, por eso se borraron explícitamente arriba.
  DELETE FROM promotions WHERE id = ANY(promo);
  DELETE FROM service    WHERE id = ANY(serv);

  RAISE NOTICE 'DESPUES: % servicios activos, % promociones',
    (SELECT count(*) FROM service WHERE is_active), (SELECT count(*) FROM promotions);
END $$;

-- ── Verificación. Correr aparte; las nueve columnas tienen que dar lo que dice
--    el nombre. ────────────────────────────────────────────────────────────────
-- SELECT
--   (SELECT count(*) FROM service WHERE is_active)                              AS activos_149,
--   (SELECT count(*) FROM promotions)                                           AS promos_0,
--   (SELECT count(*) FROM promotion_service ps
--      WHERE NOT EXISTS (SELECT 1 FROM service s WHERE s.id = ps.service_id))   AS huerf_ps_0,
--   (SELECT count(*) FROM service_category sc
--      WHERE NOT EXISTS (SELECT 1 FROM service s WHERE s.id = sc.service_id))   AS huerf_cat_0,
--   (SELECT count(*) FROM service_embeddings se
--      WHERE NOT EXISTS (SELECT 1 FROM service s WHERE s.id = se.service_id))   AS huerf_emb_0,
--   (SELECT count(*) FROM service_machine sm
--      WHERE NOT EXISTS (SELECT 1 FROM service s WHERE s.id = sm.service_id))   AS huerf_maq_0,
--   (SELECT count(*) FROM service_provider_service sp
--      WHERE NOT EXISTS (SELECT 1 FROM service s WHERE s.id = sp.service_id))   AS huerf_prov_0,
--   (SELECT count(*) FROM service WHERE name ILIKE 'IPL %')                     AS ipl_3,
--   (SELECT count(*) FROM service WHERE name ILIKE '%LUZ PULSADA%')             AS luz_1;
