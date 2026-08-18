-- ════════════════════════════════════════════════════════════════════════════
-- 1.26.0 / 07 — Archivar el eje viejo (aparatología y técnica)
-- ════════════════════════════════════════════════════════════════════════════
-- Se corre SOLO cuando el semáforo de la Task 5d Step 1 da 0 filas, o sea cuando
-- todos los servicios ya cuelgan del eje nuevo. Antes de eso, archivarlas los
-- borra de la web.
--
-- Archivar y no borrar (regla 1.3) es lo que hace esto reversible: si el eje
-- nuevo resulta peor, se reactivan y vuelve todo como estaba, sin haber tocado
-- ni un servicio.

UPDATE categories
   SET is_active = false,
       description = COALESCE(description || ' | ', '') ||
                     'Archivada en 1.26.0: reemplazada por el eje de indicaciones/zonas.'
 WHERE (parent_category_id = '0ff003a7-9909-4434-a15e-3069eeebff89'
        AND name IN ('Alpha Synergy','Crio-Radiofrecuencia','Criolipólisis',
                     'Electrodos / Ondas Rusas','HIFU Corporal','Lipoláser',
                     'Mantas y Electrodos Térmicos','Mesoterapia Corporal','Mio Up',
                     'Ondas de Choque (Hammer)','Presoterapia','Radiofrecuencia Corporal',
                     'Ultracavitación','Vela Slim','Venus Legacy'))
    OR (parent_category_id = '5afba982-df5e-4fd4-b1ea-1dc498065c0d'
        AND name IN ('Ácido Hialurónico y Bioestimulantes','Botox','Consultas Dermatológicas',
                     'Dermapen','Mesoterapia Médica','Peeling Médico',
                     'Plasma Rico en Plaquetas (PRP)','Procedimientos Dermatológicos'));
