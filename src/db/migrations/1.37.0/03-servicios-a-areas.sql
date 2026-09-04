-- 1.37.0 / 03 — Ligar cada servicio activo a su área
--
-- No se clasifican 123 servicios a mano: se clasifican las ~24 TÉCNICAS y el
-- vínculo cae solo. Es menos trabajo, es auditable, y si una técnica quedó mal
-- asignada se corrige en un lugar y arrastra a todos sus servicios.
--
-- La regla que resuelve los bordes es "decide quién lo hace": médico →
-- Medicina y Dermatología; cosmetóloga o esteticista → Estética; masajista o
-- manicura → Masajes y Bienestar. Es la misma que ya se usa para asignar
-- proveedoras, así que no inventa un criterio nuevo.
--
-- OJO: `service_category` NO tiene columna `id` — sólo (service_id,
-- category_id, created_at).
--
-- Una sola sentencia: el SQL Editor de Supabase hace autocommit por sentencia.
DO $$
DECLARE
  v_medicina text[] := ARRAY[
    'Ácido Hialurónico y Bioestimulantes', 'Botox', 'Plasma Rico en Plaquetas (PRP)',
    'Mesoterapia Médica', 'Mesoterapia Corporal', 'Medicina Terapéutica',
    'Dermatología Clínica', 'Procedimientos Dermatológicos', 'Consultas Dermatológicas',
    'Dermapen', 'Peeling Médico', 'Rinomodelación', 'Dermatología', 'Dermatología Estética'
  ];
  v_estetica text[] := ARRAY[
    'Aparatología Facial', 'Limpieza de Cutis y Cosmetología', 'Cosmetología',
    'Estética Corporal', 'Peeling y Dermaplaning', 'Tratamientos Faciales por Sesiones',
    'Hidratación de Labios'
  ];
  v_masajes text[] := ARRAY['Manicuría', 'Masajes', 'Belleza'];
  v_huerfanos integer;
BEGIN
  -- Por técnica
  INSERT INTO service_category (service_id, category_id, created_at)
  SELECT DISTINCT sc.service_id, a.id, now()
  FROM service_category sc
  JOIN service   s ON s.id = sc.service_id AND s.is_active
  JOIN categories t ON t.id = sc.category_id
  JOIN categories a ON a.kind = 'area' AND a.name = CASE
         WHEN t.name = ANY(v_medicina) THEN 'Medicina y Dermatología'
         WHEN t.name = ANY(v_estetica) THEN 'Estética'
         WHEN t.name = ANY(v_masajes)  THEN 'Masajes y Bienestar'
       END
  WHERE NOT EXISTS (
    SELECT 1 FROM service_category x
    WHERE x.service_id = sc.service_id AND x.category_id = a.id
  );

  -- Todo lo que cuelga de una máquina es aparatología: va a Estética.
  INSERT INTO service_category (service_id, category_id, created_at)
  SELECT DISTINCT sc.service_id, a.id, now()
  FROM service_category sc
  JOIN service   s ON s.id = sc.service_id AND s.is_active
  JOIN categories m ON m.id = sc.category_id AND m.kind = 'maquina'
  JOIN categories a ON a.kind = 'area' AND a.name = 'Estética'
  WHERE NOT EXISTS (
    SELECT 1 FROM service_category x
    WHERE x.service_id = sc.service_id AND x.category_id = a.id
  );

  SELECT count(*) INTO v_huerfanos
  FROM service s
  WHERE s.is_active AND NOT EXISTS (
    SELECT 1 FROM service_category sc
    JOIN categories c ON c.id = sc.category_id AND c.kind = 'area'
    WHERE sc.service_id = s.id);

  RAISE NOTICE 'Servicios activos sin área: %  (tiene que ser 0)', v_huerfanos;
  RAISE NOTICE 'Estética=% Medicina=% Masajes=%',
    (SELECT count(*) FROM service_category sc JOIN categories c ON c.id=sc.category_id
       JOIN service s ON s.id=sc.service_id AND s.is_active WHERE c.name='Estética'),
    (SELECT count(*) FROM service_category sc JOIN categories c ON c.id=sc.category_id
       JOIN service s ON s.id=sc.service_id AND s.is_active WHERE c.name='Medicina y Dermatología'),
    (SELECT count(*) FROM service_category sc JOIN categories c ON c.id=sc.category_id
       JOIN service s ON s.id=sc.service_id AND s.is_active WHERE c.name='Masajes y Bienestar');
END $$;
