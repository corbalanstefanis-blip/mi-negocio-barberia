# MI NEGOCIO ADMIN — Licencias y suscripciones v1

## Objetivo
Centralizar altas, bajas, pagos, licencias, precios, usuarios internos, auditoría y conservación de datos de todos los locales de MI NEGOCIO.

## Reglas comerciales confirmadas

### Precio
- Primeros 10 locales: ARS 9.900/mes durante sus primeros 3 meses.
- Desde el 4.º mes: 20% de descuento Fundador sobre el precio de lista vigente mientras mantengan la suscripción activa.
- Local 11 en adelante: precio de lista vigente.
- Precio inicial de lista: ARS 14.900/mes.
- Revisión de tarifa: mensual.
- Protección inicial del precio de lista: hasta 2027-02-07, salvo circunstancia extraordinaria.
- Ningún cambio modifica períodos ya abonados.

### Garantía
- 10 días desde el alta inicial.
- La devolución afecta el pago inicial correspondiente, no meses anteriores ya utilizados.

### Mora y suspensión
- Vencimiento: día 0.
- Gracia: 10 días.
- Día 11: suspensión.
- Suspensión no elimina datos.
- 0–90 días desde el vencimiento: suspendida recuperable.
- 91–180 días: archivada.
- Día 180: revisión de cierre/eliminación.
- La eliminación definitiva nunca es automática: requiere acción expresa de un propietario/admin autorizado.

### Reactivación
- Dentro del período de conservación, el pago reactiva la cuenta y conserva clientes, servicios, caja, stock, historial y configuración.
- Una suspensión por mora no elimina el beneficio Fundador.
- Una cancelación definitiva y posterior alta como cuenta nueva puede perder el beneficio Fundador.

### Baja voluntaria
- Si la baja se pide fuera del período de garantía, no se devuelve automáticamente el mes en curso.
- La cuenta sigue activa hasta el final del período ya abonado.
- No se cobra el período siguiente.
- No hay penalidad por cancelar.
- Cada solicitud de baja debe generar un número de registro.

## Estados de licencia
- ACTIVE
- GRACE
- SUSPENDED
- ARCHIVED
- CANCELLATION_PENDING
- CANCELLED
- DELETION_REVIEW
- CLOSED
- REFUNDED

## Roles internos
- OWNER: control total. Stefania y Lean.
- ADMIN: altas, pagos, soporte, suspensión/reactivación.
- SUPPORT: soporte operativo sin permisos para precios, dinero ni eliminación.
- VIEWER: solo lectura.

La arquitectura debe permitir sumar más OWNER/ADMIN/SUPPORT/VIEWER en el futuro.

## ADMIN debe mostrar
- Dashboard: activos, gracia, suspendidos, archivados, bajas, ingresos esperados/cobrados/pendientes.
- Locales: nombre, titular, contacto, slug, alta, plan, cohorte, estado, última actividad.
- Suscripciones: precio, descuento, próxima renovación, gracia, vencimiento.
- Pagos: histórico inmutable, importe, medio, referencia, fecha, devolución, contracargo.
- Tarifas: lista vigente, historial, revisión mensual, Fundadores.
- Licencias: activar, suspender, reactivar, archivar, cancelar, cerrar.
- Dispositivos: vinculados, último uso, revocar.
- Datos: respaldo, retención, archivo, revisión de eliminación.
- Soporte: incidencias y notas.
- Auditoría: cada cambio con usuario, fecha, acción y motivo.
- Usuarios internos y roles.

## App del local
En Más → Mi suscripción:
- Estado
- Plan
- Precio actual
- Próxima renovación
- Historial de pagos
- Pagar / Regularizar
- Cancelar suscripción
- Políticas y condiciones
- Privacidad

Si está suspendida, la app bloquea las funciones operativas y deja disponibles únicamente estado, pago/reactivación, políticas, privacidad y soporte.

## Aceptación legal
Registrar:
- business slug
- versión de políticas
- fecha/hora
- usuario/titular
- canal/flujo de aceptación
- IP/user-agent si corresponde y es necesario

## Seguridad
- Nunca guardar números de tarjeta.
- Credenciales de pago solo en servidor.
- ADMIN requiere autenticación real.
- Sesiones revocables.
- Auditoría inmutable.
- Toda eliminación definitiva requiere confirmación de OWNER.
