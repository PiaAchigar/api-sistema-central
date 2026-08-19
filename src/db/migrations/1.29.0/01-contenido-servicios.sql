-- ═══════════════════════════════════════════════════════════════════════════
-- 1.29.0 — Contenido de servicios (beneficios / contraindicaciones / notas)
--
-- POR QUÉ EXISTE: este contenido vivía en `batch_1..5_services.json`, cinco
-- archivos sueltos en la raíz del repo, producto de una carga por lotes que
-- quedó a mitad de camino: de los 23 servicios que traían texto, sólo 14
-- habían llegado a la base. Los otros 9 se iban a perder al limpiar la raíz.
--
-- Los UPDATE son IDEMPOTENTES: cada columna se toca sólo si está en NULL, así
-- que lo que Laura haya editado a mano desde el panel NO se pisa, y correr
-- esto dos veces no cambia nada.
-- ═══════════════════════════════════════════════════════════════════════════

-- Media Pierna
UPDATE service SET
  benefits = COALESCE(benefits, 'Eliminación del 85% al 95% del vello. Disminución progresiva de la cantidad y tiempo de crecimiento. Mejora la calidad de la piel y contrarresta la foliculitis.'),
  contraindications = COALESCE(contraindications, 'Evitar exposición solar 48 horas antes y después de la sesión.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se recomienda 6-12 sesiones según la zona. Concurrir sin vellos (con máquina o crema). Sin maquillaje, crema o desodorante. Aplicar protector solar factor 50-100 si se trata el rostro.')
WHERE id = '3d30164c-0574-409f-a975-fb3c55e5acd7';

-- 1/2 Brazo - HOMBRE
UPDATE service SET
  benefits = COALESCE(benefits, 'Eliminación del 85% al 95% del vello. Disminución progresiva de la cantidad y tiempo de crecimiento. Mejora la calidad de la piel y contrarresta la foliculitis.'),
  contraindications = COALESCE(contraindications, 'Evitar exposición solar 48 horas antes y después de la sesión.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se recomienda 6-12 sesiones según la zona. Concurrir sin vellos (con máquina o crema). Sin maquillaje, crema o desodorante. Aplicar protector solar factor 50-100 si se trata el rostro.')
WHERE id = 'f5506830-ffdd-4cba-a123-0007b0d3389b';

-- Cavado completo
UPDATE service SET
  benefits = COALESCE(benefits, 'Eliminación del 85% al 95% del vello. Disminución progresiva de la cantidad y tiempo de crecimiento. Mejora la calidad de la piel y contrarresta la foliculitis.'),
  contraindications = COALESCE(contraindications, 'Evitar exposición solar 48 horas antes y después de la sesión.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se recomienda 6-12 sesiones según la zona. Concurrir sin vellos (con máquina o crema). Sin maquillaje, crema o desodorante. Aplicar protector solar factor 50-100 si se trata el rostro.')
WHERE id = 'ef6a4ccc-f784-4b7d-a3a2-d9f9471b1e89';

-- Axila
UPDATE service SET
  benefits = COALESCE(benefits, 'Eliminación del 85% al 95% del vello. Disminución progresiva de la cantidad y tiempo de crecimiento. Mejora la calidad de la piel y contrarresta la foliculitis.'),
  contraindications = COALESCE(contraindications, 'Evitar exposición solar 48 horas antes y después de la sesión.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se recomienda 6-12 sesiones según la zona. Concurrir sin vellos (con máquina o crema). Sin maquillaje, crema o desodorante. Aplicar protector solar factor 50-100 si se trata el rostro.')
WHERE id = 'ad45ae15-e3f8-4bac-8968-f3e48c0bd5b0';

-- Abdomen
UPDATE service SET
  benefits = COALESCE(benefits, 'Eliminación del 85% al 95% del vello. Disminución progresiva de la cantidad y tiempo de crecimiento. Mejora la calidad de la piel y contrarresta la foliculitis.'),
  contraindications = COALESCE(contraindications, 'Evitar exposición solar 48 horas antes y después de la sesión.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se recomienda 6-12 sesiones según la zona. Concurrir sin vellos (con máquina o crema). Sin maquillaje, crema o desodorante. Aplicar protector solar factor 50-100 si se trata el rostro.')
WHERE id = '390fcb66-3a19-4526-ac83-d461f27a8d4f';

-- Abdomen y Pecho
UPDATE service SET
  benefits = COALESCE(benefits, 'Eliminación del 85% al 95% del vello. Notarás resultados desde la 2da sesión. Mejora la calidad de la piel.'),
  contraindications = COALESCE(contraindications, 'Evitar exposición solar 48 horas antes y después.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se recomienda mínimo 6-9 sesiones según zona. Concurrir depilado sin crema ni maquillaje. Proteger con factor 50-100.')
WHERE id = 'a3f0f083-0862-42a5-929f-9f393fb4f6a5';

-- Alidya - Mesoterapia Anticelulítica, 2 Zonas
UPDATE service SET
  benefits = COALESCE(benefits, 'Actúa a 3 niveles: A nivel Linfático: Antioxidante con efecto rejuvenecedor, ayuda al drenaje y eliminación de toxinas en la celulitis. A nivel Celular: Estimula la liberación de grasa del tejido adiposo, devuelve equilibrio a la estructura, favorece la oxigenación. A nivel Vascular: Mejora la microcirculación local y sistémica. Visibles desde la 2da o 3ra sesión. Eliminación de acúmulos de grasa (zona más esbelta). Mejora del aspecto de la piel. Rehidratación y piel más tersa (desaparece piel de naranja)'),
  special_attention_notes = COALESCE(special_attention_notes, 'Solución eficaz y segura, puede combinarse con otros procedimientos estéticos.')
WHERE id = '1356f433-b385-41a8-a27d-4366471b406f';

-- Antebrazo
UPDATE service SET
  benefits = COALESCE(benefits, 'Eliminación del 85% al 95% del vello. Notarás resultados desde la 2da sesión. Mejora la calidad de la piel.'),
  contraindications = COALESCE(contraindications, 'Evitar exposición solar 48 horas antes y después.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se recomienda mínimo 6-9 sesiones según zona. Concurrir depilado sin crema ni maquillaje. Proteger con factor 50-100.')
WHERE id = 'bbf4dc27-fea4-4bb8-a863-9898ccf792ed';

-- Baby Botox
UPDATE service SET
  benefits = COALESCE(benefits, 'El botox o toxina botulínica nos ayuda a eliminar temporalmente las arrugas de expresión: se trata de una toxina que, una vez inyectada, impide que el músculo se contraiga, es decir que lo paraliza. De esta forma no se forma la arruga. ### \-Baby Botox: está pensado para un paciente más joven que busca prevención. Buscamos prevenir la aparición de esas arrugas de expresión más que eliminarlas. Está recomendado para los rostros más jóvenes sin arrugas marcadas pero cuya anatomía muscular comienza')
WHERE id = '317fafbb-724a-4392-8e4d-70eef3d13004';

-- Barba
UPDATE service SET
  benefits = COALESCE(benefits, 'Eliminación del 85-95% del vello facial. Resultados desde 2da sesión en disminución y tiempo de crecimiento.'),
  contraindications = COALESCE(contraindications, 'Evitar sol 48hs antes y después. No usar métodos de arranque.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se recomienda 12-20 sesiones para resultado óptimo en rostro. Concurrir depilado con máquina o crema.')
WHERE id = '233aa29c-8125-4722-8419-c53baa5e3ba8';

-- Botox para Bruxismo
UPDATE service SET
  benefits = COALESCE(benefits, 'Puede generar molestia leve, pero se puede utilizar anestesia tópica para mayor confort.')
WHERE id = '3001ae13-94af-4c46-995e-35312401d868';

-- Botox para Hiperhidrosis
UPDATE service SET
  benefits = COALESCE(benefits, 'Es un procedimiento ambulatorio, puede generar una molestia leve y transitoria. En caso necesario se utiliza anestesia local para mayor confort.')
WHERE id = '859167dc-472d-4209-b012-0e4d8bde30cb';

-- Bozo
UPDATE service SET
  benefits = COALESCE(benefits, 'Eliminación del vello del labio superior del 85-95%. Disminución del crecimiento. Mejora la calidad de la piel.'),
  contraindications = COALESCE(contraindications, 'Evitar exposición solar 48 horas antes y después.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se recomienda 6-12 sesiones. Concurrir sin vellos. Sin crema, maquillaje o desodorante.')
WHERE id = '86483ffa-18f2-4a38-a0b7-c10e7a489663';

-- Brazo completo y Pierna entera
UPDATE service SET
  benefits = COALESCE(benefits, 'Eliminación del 85-95% del vello en múltiples zonas grandes. Disminución progresiva. Mejora la calidad de la piel.'),
  contraindications = COALESCE(contraindications, 'Evitar sol 48 horas antes y después de sesión.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se recomienda 9-12 sesiones según zona. Concurrir depilado. Sin maquillaje ni desodorante.')
WHERE id = '96517315-83b5-4255-8ed0-28fb2c470d3d';

-- Cavado
UPDATE service SET
  benefits = COALESCE(benefits, 'Con respecto a la cantidad de sesiones, va a depender de la zona del cuerpo, de la edad, del tipo de piel y tipo de vello del paciente. Se estima un mínimo de 6 a 9 sesiones dependiendo la zona del cuerpo, por ejemplo lo que es CAVADO o PELVIS suele necesitar un mínimo de 9 y depende el paciente a veces hasta unas 16 sesiones, para lograr un tratamiento efectivo eliminando el vello entre un 85% y 95%. Es importante aclarar que esto es un estimado y que no todos los cuerpos reaccionan igual al tr')
WHERE id = '2c8d24f8-5d9c-41c1-b176-85dcb1312ddb';

-- Cavado y Axila / Bozo / Tira de cola
UPDATE service SET
  benefits = COALESCE(benefits, 'Eliminación del 85-95% del vello en zonas íntimas. Mejora la calidad de la piel y contrarresta la foliculitis.'),
  contraindications = COALESCE(contraindications, 'Evitar sol 48 horas antes y después. No usar métodos de arranque durante tratamiento.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se recomienda 9-16 sesiones según zona íntima y paciente. Concurrir depilado con máquina. Sin crema.')
WHERE id = '21e68820-849e-4044-a675-7dddc2e67a54';

-- Electrocoagulación / Extracción de Verrugas
UPDATE service SET
  benefits = COALESCE(benefits, 'Extracción efectiva de verrugas y acrocordones. Generalmente una sesión es suficiente.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se extraen aproximado de 4 verrugas por sesión. Depende de profundidad y tamaño. Si se observa anomalía, se recomienda biopsia.')
WHERE id = '88702628-5522-4c1c-8e37-23586f0280e6';

-- Glúteos
UPDATE service SET
  benefits = COALESCE(benefits, 'Eliminación del 85-95% del vello. Disminución progresiva y mejora de la calidad de la piel.'),
  contraindications = COALESCE(contraindications, 'Evitar exposición solar 48 horas antes y después de sesión.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se recomienda 6-12 sesiones según tipo de piel. Concurrir depilado. Evitar métodos de arranque durante tratamiento.')
WHERE id = '1d4487ce-4588-4a17-8a89-8cb402ae81b4';

-- Glúteos y Pelvis
UPDATE service SET
  benefits = COALESCE(benefits, 'Eliminación del 85-95% del vello en zona íntima. Mejora la calidad de la piel.'),
  contraindications = COALESCE(contraindications, 'Evitar sol 48 horas antes y después. No usar arranque de vello.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se recomienda 9-16 sesiones según paciente. Concurrir depilado con máquina o crema.')
WHERE id = '05487c42-926f-47ec-a3b7-a8c34c1eadca';

-- Glúteos y Tira de cola
UPDATE service SET
  benefits = COALESCE(benefits, 'Eliminación del 85-95% del vello en zona íntima y glúteos. Disminución del tiempo de crecimiento.'),
  contraindications = COALESCE(contraindications, 'Evitar exposición solar 48 horas antes y después.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se recomienda 9-12 sesiones. Concurrir depilado sin crema. No usar métodos de arranque.')
WHERE id = '377578bf-7387-4af1-916b-9446b212e61f';

-- Hialuronidasa
UPDATE service SET
  benefits = COALESCE(benefits, 'La hialuronidasa es una enzima que se utiliza para disolver o reducir el ácido hialurónico previamente aplicado. Su uso está indicado cuando se busca corregir resultados no deseados, asimetrías, exceso de producto o ante la necesidad de revertir parcial o totalmente un relleno. Su efecto puede comenzar a notarse en las primeras horas, aunque el resultado final se evalúa luego de algunos días. \¿Cómo es el procedimiento?\ La respuesta varía según cada paciente, el tipo y la cantidad de ácido hial'),
  contraindications = COALESCE(contraindications, 'Evitar masajes o manipulación de la zona durante las primeras horas. Seguir las indicaciones brindadas por el profesional. Ante cualquier molestia inusual, comunicarse con el equipo.'),
  special_attention_notes = COALESCE(special_attention_notes, 'La hialuronidasa es una enzima que se utiliza para disolver o reducir el ácido hialurónico previamente aplicado. Su uso está indicado cuando se busca corregir resultados no deseados, asimetrías, exceso de producto o ante la necesidad de revertir parcial o totalmente un relleno. Su efecto puede comenzar a notarse en las primeras horas, aunque el resultado final se evalúa luego de algunos días. \¿Cómo es el procedimiento?\ En algunos casos puede ser necesaria más de una sesión para lograr el resul')
WHERE id = '168c6067-3ed5-42c8-badb-96eba7c0ed5c';

-- Hidratación de Labios
UPDATE service SET
  benefits = COALESCE(benefits, '\- se debe evaluar previamente la zona a tratar para definir el presupuesto exacto. \Este valor es para una zona de 20 x 20 cm aproximadamente\ (dos palmas de la mano). Tratamiento intensivo con Ácido Hialurónico 💋💧 La hidratación de labios es un tratamiento pensado para \restaurar la suavidad, elasticidad y confort\ de los labios, devolviéndoles un aspecto más saludable, luminoso y natural.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Trabajamos con la \línea de ampollas Concentré de Dermassy\, formulada con \Ácido Hialurónico al 3,5%\, un activo clave para la hidratación profunda y el cuidado de la piel.')
WHERE id = '11d0f80d-c8fa-40fb-b4db-a895d2fd4df7';

-- Hombros
UPDATE service SET
  benefits = COALESCE(benefits, 'Eliminación del 85-95% del vello. Mejora la calidad de la piel. Disminución del crecimiento.'),
  contraindications = COALESCE(contraindications, 'Evitar sol 48 horas antes y después de sesión.'),
  special_attention_notes = COALESCE(special_attention_notes, 'Se recomienda 6-9 sesiones según tipo de piel y vello. Concurrir depilado sin maquillaje.')
WHERE id = '2f9bbf9e-728a-4f26-9a50-672abdf5edfa';

-- ── Verificación ───────────────────────────────────────────────────────────
-- Antes de esta migración: 14 de estos 23 servicios tenían contenido.
-- Después debería dar 23.
-- SELECT count(*) FILTER (WHERE benefits IS NOT NULL) FROM service
--   WHERE id IN (...);