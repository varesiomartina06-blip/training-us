// training.us — app.js (fase 1: acceso, perfil, metas, zona horaria y "Juntos hoy")
(() => {
  const cfg = window.TRAINING_US_CONFIG;
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  if (!cfg || cfg.supabaseUrl.startsWith("PEGA_AQUI")) {
    $("acceso").hidden = false;
    return avisar("Falta configurar config.js con la Project URL y la llave de Supabase.");
  }
  const db = window.supabase.createClient(cfg.supabaseUrl.replace(/\/+$/, ""), cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  // ---------------------------------------------------------------- estado
  let usuario = null;     // sesión de Supabase
  let estado = null;      // resultado de estado_general()
  let perfil = null;      // mi fila de perfiles
  let vistaActual = "inicio";
  let correoActual = "";

  // ---------------------------------------------------------------- utilidades de fechas (ISO "AAAA-MM-DD")
  const aFecha = (iso) => new Date(iso + "T00:00:00Z");
  const aISO = (d) => d.toISOString().slice(0, 10);
  const sumarDias = (iso, n) => { const d = aFecha(iso); d.setUTCDate(d.getUTCDate() + n); return aISO(d); };
  const sumarMeses = (iso, n) => { const d = aFecha(iso); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); return aISO(d); };
  const mesMeta = (lunes) => sumarDias(lunes, 3).slice(0, 7) + "-01";
  const fmt = (iso, op) => new Intl.DateTimeFormat("es", { timeZone: "UTC", ...op }).format(aFecha(iso));
  const nombreMes = (iso) => fmt(iso, { month: "long", year: "numeric" });
  const fechaCorta = (iso) => fmt(iso, { day: "numeric", month: "short" });
  const DIAS = ["L", "M", "X", "J", "V", "S", "D"];

  // ---------------------------------------------------------------- utilidades de sueño
  const aMin = (h) => { if (!h) return null; const [a, b] = h.split(":").map(Number); return a * 60 + b; };
  const aHora = (m) => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); };
  const duracion = (dormir, despertar) => {
    const a = aMin(dormir), b = aMin(despertar);
    if (a === null || b === null) return null;
    let d = b - a; if (d <= 0) d += 1440; return d;
  };
  const textoDuracion = (min) => `${Math.floor(min / 60)} h${min % 60 ? " " + (min % 60) + " min" : ""}`;
  // Límites de sueño (la base de datos también los valida con la tabla de ajustes)
  const SUENO = { min: 6 * 60, max: 10 * 60, sugerido: 8 * 60 };

  // ---------------------------------------------------------------- mensajes
  let temporizador;
  function avisar(texto, tipo = "error") {
    const m = $("mensaje");
    clearTimeout(temporizador);
    m.textContent = texto || "";
    m.className = "mensaje" + (tipo === "ok" ? " ok" : "");
    m.hidden = !texto;
    if (texto && tipo === "ok") temporizador = setTimeout(() => (m.hidden = true), 3500);
  }
  function errorLegible(error) {
    const t = error?.message || String(error);
    if (/row-level security/i.test(t)) return "Ese periodo ya empezó y no se puede modificar.";
    if (/JWT|session/i.test(t)) return "Tu sesión caducó. Cierra sesión y vuelve a entrar.";
    return t;
  }

  // ================================================================ ACCESO
  function mostrarAcceso(paso) {
    $("app").hidden = true;
    $("acceso").hidden = false;
    $("paso-correo").hidden = paso !== "correo";
    $("paso-codigo").hidden = paso !== "codigo";
  }

  $("form-correo").addEventListener("submit", async (e) => {
    e.preventDefault();
    const correo = $("correo").value.trim().toLowerCase();
    if (!correo.includes("@")) return avisar("Escribe un correo válido.");
    const boton = e.submitter; boton.disabled = true; avisar("");
    const { error } = await db.auth.signInWithOtp({ email: correo, options: { shouldCreateUser: false } });
    boton.disabled = false;
    if (error) {
      const t = (error.message || "").toLowerCase();
      if (t.includes("signup") || t.includes("not allowed") || error.status === 422) return avisar("Este correo no tiene acceso a training.us.");
      if (error.status === 429 || t.includes("rate")) return avisar("Se pidieron demasiados códigos. Espera unos minutos y vuelve a intentarlo.");
      return avisar("No se pudo enviar el código: " + error.message);
    }
    correoActual = correo;
    $("correo-enviado").textContent = correo;
    $("codigo").value = "";
    mostrarAcceso("codigo");
    avisar("Código enviado. Revisa también la carpeta de spam.", "ok");
    $("codigo").focus();
  });

  $("form-codigo").addEventListener("submit", async (e) => {
    e.preventDefault();
    const codigo = $("codigo").value.replace(/\D/g, "");
    if (codigo.length < 6) return avisar("El código tiene al menos 6 números.");
    const boton = e.submitter; boton.disabled = true; avisar("");
    const { data, error } = await db.auth.verifyOtp({ email: correoActual, token: codigo, type: "email" });
    boton.disabled = false;
    if (error) return avisar("El código no es válido o ya caducó. Pide uno nuevo.");
    avisar("");
    await entrar(data.user);
  });

  $("otro-correo").addEventListener("click", () => { avisar(""); mostrarAcceso("correo"); });

  async function salir() {
    await db.auth.signOut();
    usuario = estado = perfil = null;
    document.body.classList.remove("tema-rosa", "tema-azul");
    mostrarPestanas(false);
    $("correo").value = "";
    mostrarAcceso("correo");
  }

  // ================================================================ CARGA DE DATOS
  async function entrar(u) {
    usuario = u;
    $("acceso").hidden = true;
    $("app").hidden = false;
    $("vista").innerHTML = `<p class="sub">Cargando…</p>`;
    // Zona horaria automática del teléfono
    const zona = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const rz = await db.rpc("registrar_zona", { p_zona: zona });
    if (rz.error) console.warn("Zona:", rz.error.message);
    else if (rz.data === "cambio_programado") avisar(`Detectamos la zona ${zona}. Se aplicará desde mañana.`, "ok");
    await recargar();
    limpiarComprobantes().catch(() => {});
    limpiarFotosComida().catch(() => {});
  }

  async function recargar() {
    const [e, p] = await Promise.all([
      db.rpc("estado_general"),
      db.from("perfiles").select("*").eq("id", usuario.id).single()
    ]);
    if (e.error || p.error) {
      $("vista").innerHTML = "";
      return avisar("No se pudieron cargar los datos: " + errorLegible(e.error || p.error) +
        ". ¿Ejecutaste el script fase1.sql en Supabase?");
    }
    estado = e.data;
    perfil = p.data;
    document.body.classList.remove("tema-rosa", "tema-azul");
    if (perfil.tema) document.body.classList.add("tema-" + perfil.tema);
    if (!perfil.completado) return vistaPerfil(true);
    mostrarPestanas(true);
    irA(vistaActual);
    if (location.hash) { abrirDesdeUrl(location.hash); history.replaceState(null, "", location.pathname); }
  }

  function mostrarPestanas(si) {
    $("pestanas").hidden = !si;
    document.body.classList.toggle("con-pestanas", si);
  }

  const yo = () => estado.participantes.find((x) => x.id === estado.yo);
  const pareja = () => estado.participantes.find((x) => x.id !== estado.yo);
  const antesDelInicio = () => !estado.fecha_inicio || yo().hoy < estado.fecha_inicio;

  // ================================================================ NAVEGACIÓN
  $("pestanas").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-vista]");
    if (b) irA(b.dataset.vista);
  });
  function irA(v) {
    vistaActual = v;
    if (v === "registrar") v = "entrenar";
    if (v === "comida-form") v = "comida";
    if (v === "receta-editor") v = "recetas";
    if (v === "reporte") v = "exportar";
    vistaActual = v;
    const pestana = ["multas", "recompensas", "mensajes", "ausencias", "perfil", "coach", "exportar", "metas", "estadisticas", "aprende"].includes(v) ? "mas"
      : ["recetas", "checkin"].includes(v) ? "comida" : ["salud"].includes(v) ? "habitos" : v;
    document.querySelectorAll("#pestanas button").forEach((b) => {
      if (b.dataset.vista === pestana) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    window.scrollTo(0, 0);
    if (!$("hoja").hidden) cerrarHoja();
    if (v === "inicio") vistaInicio();
    else if (v === "entrenar") vistaEntrenar();
    else if (v === "ausencias") vistaAusencias();
    else if (v === "mensajes") vistaMensajes();
    else if (v === "recompensas") vistaRecompensas();
    else if (v === "metas") vistaMetas();
    else if (v === "multas") vistaMultas();
    else if (v === "comida") vistaComida();
    else if (v === "mas") vistaMas();
    else if (v === "coach") vistaCoach("general");
    else if (v === "habitos") vistaHabitos();
    else if (v === "estadisticas") vistaEstadisticas();
    else if (v === "aprende") vistaAprende();
    else if (v === "salud") vistaSalud();
    else if (v === "recetas") vistaRecetas();
    else if (v === "checkin") vistaCheckin();
    else if (v === "exportar") vistaExportar();
    else vistaPerfil(false);
  }

  // ================================================================ INICIO
  const ZONAS = { "America/Panama": "Panamá", "Europe/Madrid": "España", "Atlantic/Canary": "Canarias" };
  const nombreZona = (z) => ZONAS[z] || z.split("/").pop().replace(/_/g, " ");

  function tarjetaParticipante(p, esYo) {
    const tema = p.tema || "";
    const nombre = esc(p.nombre || "Sin nombre todavía");
    const meta = p.meta_mes;
    const sem = p.meta_semana;
    const hechos = p.dias_entrenados || [];
    const plan = p.plan || sem?.dias_previstos || [];
    const excusas = p.excusas || {};
    const dias = DIAS.map((d, i) => {
      const n = i + 1, prev = plan.includes(n), hecho = hechos.includes(n), exc = excusas[n];
      const marca = hecho ? "✓" : exc ? MOTIVOS[exc]?.[0] || "•" : d;
      return `<span class="dia ${prev ? "on" : ""} ${hecho ? "hecho" : ""} ${hecho && !prev ? "extra" : ""} ${exc && !hecho ? "excusado" : ""}" aria-label="${d}${hecho ? ", entrenado" : exc ? ", " + (MOTIVOS[exc]?.[1] || "") : prev ? ", previsto" : ""}">${marca}</span>`;
    }).join("");
    const metaEf = meta ? metaEfectiva(p) : 0;
    const pz = p.pausa;
    const sinActualizar = pz?.estado === "activa" && (!pz.ultima_actualizacion || pz.ultima_actualizacion < sumarDias(p.hoy, -2));
    const zonaTxt = nombreZona(p.zona);
    return `
      <section class="tarjeta ${tema}">
        <div class="masc-tarjeta" data-masc="${p.id}"></div>
        <h3 class="nombre-${tema}">${nombre}${esYo ? " (tú)" : ""}</h3>
        <p>${meta ? `${Math.min(hechos.length, metaEf)} de ${metaEf} días con entrenamiento esta semana${metaEf < meta.entrenos_semana ? ` <small>(meta ${meta.entrenos_semana}, ${meta.entrenos_semana - metaEf} excusado${meta.entrenos_semana - metaEf === 1 ? "" : "s"})</small>` : ""}` : "Todavía sin metas del mes"}</p>
        <div class="dias">${dias}</div>
        ${sem ? "" : `<p>Sin días previstos esta semana</p>`}
        <p>Hora de ${esc(zonaTxt)}</p>
        ${!p.completado ? `<p>Aún no ha completado su perfil.</p>` : ""}
        ${pz?.estado === "activa" ? `<div class="aviso">⏸ En pausa por lesión desde el ${fechaCorta(pz.desde)}${sinActualizar ? ". Sin actualizar desde hace días: pendiente de revisión." : "."}</div>` : ""}
        ${pz?.estado === "solicitada" ? `<div class="aviso">⏸ Pausa por lesión solicitada, esperando respuesta.</div>` : ""}
        ${p.zona_pendiente ? `<div class="aviso">Cambio a hora de ${esc(nombreZona(p.zona_pendiente.zona))} desde el ${fechaCorta(p.zona_pendiente.desde)}.</div>` : ""}
      </section>`;
  }

  function tarjetaJuntos() {
    const hoy = yo().hoy;
    const otro = pareja();
    const nombreOtro = esc(otro?.nombre || "tu pareja");
    const filas = estado.juntos || [];
    const confirmadoHoy = filas.find((j) => j.fecha === hoy && j.confirmado_por);
    const deEl = filas.find((j) => !j.confirmado_por && j.propuesto_por !== estado.yo);
    const mio = filas.find((j) => j.fecha === hoy && !j.confirmado_por && j.propuesto_por === estado.yo);
    let cuerpo;
    if (confirmadoHoy) cuerpo = `<p>Hoy están juntos. 💗</p>`;
    else if (deEl) cuerpo = `
      <p>${nombreOtro} dice que el ${fechaCorta(deEl.fecha)} están juntos.</p>
      <div class="acciones-juntos">
        <button type="button" data-juntos="si" data-fecha="${deEl.fecha}">Confirmar</button>
        <button type="button" class="secundario" style="margin:0" data-juntos="no" data-fecha="${deEl.fecha}">No es así</button>
      </div>`;
    else if (mio) cuerpo = `
      <p>Esperando que ${nombreOtro} lo confirme.</p>
      <div class="acciones-juntos"><button type="button" class="secundario" style="margin:0" data-juntos="no" data-fecha="${mio.fecha}">Retirar</button></div>`;
    else cuerpo = `
      <p>Márcalo cuando estén en el mismo lugar; ${nombreOtro} tendrá que confirmarlo.</p>
      <div class="acciones-juntos"><button type="button" data-juntos="proponer">Estamos juntos hoy</button></div>`;
    return `<section class="tarjeta"><h3>Juntos hoy</h3>${cuerpo}</section>`;
  }

  async function vistaInicio() {
    const p = pareja();
    $("vista").innerHTML = `
      <h2 class="titulo">Hola, ${esc(perfil.nombre)}</h2>
      <div id="inicio-mensajes"></div>
      <div id="inicio-recompensas"></div>
      <div id="por-responder-inicio"></div>
      <div id="marcador"><section class="tarjeta"><p class="vacio">Cargando marcador…</p></section></div>
      ${tarjetaParticipante(yo(), true)}
      ${p ? tarjetaParticipante(p, false) : ""}
      <div id="accion-dia"></div>
      <div id="inicio-pendientes"></div>
      ${tarjetaJuntos()}`;
    cargarPendientesJuntos($("inicio-pendientes"));
    pintarMascotasInicio();
    cargarAccionDia();
    cargarPorResponder($("por-responder-inicio"));
    tarjetaMensajes($("inicio-mensajes"));
    tarjetaRecompensas($("inicio-recompensas"));
    const [mr, mu] = await Promise.all([db.rpc("marcador"), db.rpc("estado_multas")]);
    const data = mr.data, error = mr.error;
    if (error || !data) { $("marcador").innerHTML = ""; return avisar("No se pudo cargar el marcador: " + errorLegible(error) + ". ¿Ejecutaste fase3.sql?"); }
    if (vistaActual !== "inicio") return;
    $("marcador").innerHTML = htmlMarcador(data, mu.data);
    const mia = mu.data?.participantes?.[0];
    if (mia && Number(mia.pendiente) > 0) {
      const vencida = mia.multas.some((m) => m.estado === "pendiente" && m.vence < mia.hoy);
      $("por-responder-inicio").insertAdjacentHTML("beforebegin", `
        <section class="tarjeta pendiente">
          <h3>💰 Tienes ${usd(mia.pendiente)} por pagar</h3>
          <p>${vencida ? "Hay multas vencidas: cada día resta puntos." : "Transfiere a tu cuenta de ahorro y sube el comprobante."}</p>
          <button type="button" class="secundario" data-ir-multas>Ir a multas</button>
        </section>`);
    }
  }

  // ================================================================ MARCADOR (fase 3)
  const pct = (a, b) => (b > 0 ? Math.round((100 * a) / b) : 100);
  function htmlMarcador(m, mu) {
    const deuda = (x) => {
      const d = mu?.participantes?.find((y) => y.id === x.id);
      return d ? (Number(d.pendiente) > 0 ? `${usd(d.pendiente)} <small>pendiente</small>` : "Al día") : "—";
    };
    const [a, b] = m.participantes;
    const pa = estado.participantes.find((x) => x.id === a.id);
    const pb = b ? estado.participantes.find((x) => x.id === b.id) : null;
    const nom = (x) => esc(x?.nombre || "—");
    const tema = (x) => x?.tema || "";
    const dif = b ? a.total - b.total : 0;
    let lider = "";
    if (b && m.activo) lider = dif === 0 ? "Van empatados" : `${nom(dif > 0 ? pa : pb)} va ganando por ${Math.abs(dif)} punto${Math.abs(dif) === 1 ? "" : "s"}`;
    const corona = (x, y) => m.activo && b && x.total > y.total ? `<span class="corona" aria-label="Va ganando">👑</span>` : "";
    const inicio = m.fecha_inicio ? fmt(m.fecha_inicio, { day: "numeric", month: "long" }) : null;

    const lado = (x, px, y) => {
      const s = x.semana;
      return `
      <div class="lado-marcador ${tema(px)}">
        ${corona(x, y || x)}
        <span class="nombre-marcador">${nom(px)}</span>
        <span class="puntos-total">${m.activo ? x.total : 0}</span>
        <span class="puntos-etiqueta">puntos</span>
        <span class="puntos-semana">${s ? `+${s.puntos_ganados} esta semana` : "Sin metas"}</span>
        ${x.total_pausa ? `<span class="puntos-semana">${x.total_pausa} durante pausas</span>` : ""}
      </div>`;
    };

    const fila = (etiqueta, fn) => `<div class="fila-stat"><span>${etiqueta}</span><strong class="${tema(pa)}">${fn(a)}</strong>${b ? `<strong class="${tema(pb)}">${fn(b)}</strong>` : ""}</div>`;
    const semanaTxt = (x) => {
      const s = x.semana; if (!s) return "—";
      const faltan = s.meta_efectiva - s.obligatorios;
      return `${s.obligatorios}/${s.meta_efectiva}${faltan > 0 ? ` <small>faltan ${faltan}</small>` : " ✓"}`;
    };
    const mesTxt = (x) => {
      if (!x.semana && !x.mes.meta) return "—";
      const s = x.semana || { obligatorios: 0, meta_efectiva: 0 };
      return pct(x.mes.obligatorios + s.obligatorios, x.mes.meta + s.meta_efectiva) + " %";
    };
    const r = (x, k) => x.rachas[k] + (x.rachas[k + "_max"] > x.rachas[k] ? ` <small>máx. ${x.rachas[k + "_max"]}</small>` : "");

    return `
      <section class="tarjeta marcador">
        ${m.activo ? "" : `<p class="aviso" style="margin:0 0 14px">Vista previa: ${inicio ? `el desafío empieza el ${inicio}` : "la fecha de inicio está por definir"}. Los puntos se acumulan desde ese día; mientras tanto ves cómo va tu semana.</p>`}
        <div class="marcador-cols">
          ${lado(a, pa, b)}
          ${b ? `<span class="vs">vs</span>${lado(b, pb, a)}` : ""}
        </div>
        ${lider ? `<p class="lider">${lider}</p>` : ""}
        ${(a.semana?.en_pausa) ? `<p class="aviso" style="margin:14px 0 0">⏸ Marcador en pausa por lesión: los puntos de estas semanas se guardan aparte y no cuentan para quién va ganando.</p>` : ""}
      </section>

      <section class="tarjeta">
        <div class="fila-stat cabecera"><span></span><strong class="${tema(pa)}">${nom(pa)}</strong>${b ? `<strong class="${tema(pb)}">${nom(pb)}</strong>` : ""}</div>
        ${fila("Esta semana", semanaTxt)}
        ${fila("Cumplimiento del mes", mesTxt)}
        ${fila("🔥 Racha semanal", (x) => x.semana ? r(x, "semanal") : "—")}
        ${fila("📅 Racha diaria", (x) => r(x, "diaria"))}
        ${fila("🏅 Meses perfectos seguidos", (x) => r(x, "mensual"))}
        ${fila("Adicionales este mes", (x) => x.mes.extras + (x.semana?.extras || 0))}
        ${fila("Faltas este mes", (x) => x.mes.faltas)}
        ${fila("💰 Multas", deuda)}
      </section>

      <section class="tarjeta">
        <h3>Evolución semanal</h3>
        ${graficoEvolucion(a, b, pa, pb)}
      </section>`;
  }

  function graficoEvolucion(a, b, pa, pb) {
    const series = [a, b].filter(Boolean).map((x) => x.historial);
    if (!series.some((h) => h.length)) return `<p>Aparecerá cuando se cierre la primera semana del desafío.</p>`;
    const semanas = [...new Set(series.flat().map((h) => h.semana))].sort();
    const valores = series.flat().map((h) => h.puntos);
    const max = Math.max(10, ...valores), min = Math.min(0, ...valores);
    const W = 320, H = 150, px = 28, py = 16;
    const xPos = (i) => px + (semanas.length === 1 ? (W - 2 * px) / 2 : (i * (W - 2 * px)) / (semanas.length - 1));
    const yPos = (v) => H - py - ((v - min) / (max - min)) * (H - 2 * py);
    const color = (p) => (p?.tema === "azul" ? "var(--azul-fuerte)" : "var(--rosa-fuerte)");
    const linea = (h, p) => {
      const pts = h.map((x) => [xPos(semanas.indexOf(x.semana)), yPos(x.puntos)]);
      return `<polyline fill="none" stroke="${color(p)}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" points="${pts.map((q) => q.join(",")).join(" ")}"/>` +
        pts.map((q) => `<circle cx="${q[0]}" cy="${q[1]}" r="4" fill="${color(p)}"/>`).join("");
    };
    return `
      <svg viewBox="0 0 ${W} ${H + 18}" class="grafico" role="img" aria-label="Puntos por semana">
        <line x1="${px}" x2="${W - px}" y1="${yPos(0)}" y2="${yPos(0)}" stroke="var(--borde)" stroke-width="1"/>
        ${linea(a.historial, pa)}${b ? linea(b.historial, pb) : ""}
        ${semanas.map((s, i) => `<text x="${xPos(i)}" y="${H + 12}" text-anchor="middle" font-size="10" fill="var(--texto-suave)">${fechaCorta(s)}</text>`).join("")}
      </svg>
      <div class="leyenda"><span><i style="background:${color(pa)}"></i>${esc(pa?.nombre || "")}</span>${b ? `<span><i style="background:${color(pb)}"></i>${esc(pb?.nombre || "")}</span>` : ""}</div>`;
  }

  $("vista").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-juntos]");
    if (!b) return;
    b.disabled = true;
    const r = b.dataset.juntos === "proponer"
      ? await db.rpc("proponer_juntos")
      : await db.rpc("responder_juntos", { p_fecha: b.dataset.fecha, p_acepta: b.dataset.juntos === "si" });
    if (r.error) { b.disabled = false; return avisar(errorLegible(r.error)); }
    const textos = { propuesto: "Listo. Falta que tu pareja lo confirme.", confirmado: "¡Confirmado! Hoy están juntos.", retirado: "Solicitud retirada.", ya_confirmado: "Hoy ya estaba confirmado." };
    avisar(textos[r.data] || "Listo.", "ok");
    await recargar();
  });

  // ================================================================ PERFIL
  function vistaPerfil(esPrimeraVez) {
    mostrarPestanas(!esPrimeraVez);
    const temaDefecto = perfil.tema || cfg.usuarios?.[perfil.email]?.tema || "rosa";
    const v = (x) => esc(x ?? "");
    $("vista").innerHTML = `
      <h2 class="titulo">${esPrimeraVez ? "Bienvenida a training.us" : "Tu perfil"}</h2>
      <p class="sub">${esPrimeraVez ? "Antes de empezar, completa tu perfil. Podrás cambiarlo cuando quieras." : "Tu pareja puede ver esta información, salvo el peso."}</p>
      <form id="form-perfil" class="tarjeta" novalidate>
        <div class="campo"><label for="pf-nombre">Nombre o apodo</label>
          <input id="pf-nombre" maxlength="40" required value="${v(perfil.nombre)}"></div>
        <div class="campo"><label for="pf-nac">Fecha de nacimiento</label>
          <input id="pf-nac" type="date" required value="${v(perfil.fecha_nacimiento)}"></div>
        <div class="campo"><span class="grupo-titulo">Sexo</span>
          <div class="opciones">
            ${[["femenino", "Femenino"], ["masculino", "Masculino"], ["otro", "Otro"]].map(([k, t]) =>
              `<label><input type="radio" name="pf-sexo" value="${k}" ${perfil.sexo === k ? "checked" : ""}><span>${t}</span></label>`).join("")}
          </div></div>
        <div class="fila campo">
          <div><label for="pf-estatura">Estatura (cm)</label><input id="pf-estatura" type="number" inputmode="decimal" min="100" max="250" step="0.1" required value="${v(perfil.estatura_cm)}"></div>
          ${esPrimeraVez ? `<div><label for="pf-peso">Peso inicial (kg)</label><input id="pf-peso" type="number" inputmode="decimal" min="30" max="300" step="0.1" required></div>` : "<div></div>"}
        </div>
        ${esPrimeraVez ? `<p class="privado" style="margin:-6px 0 20px">🔒 El peso es privado: solo tú lo ves.</p>` : ""}
        <div class="campo"><label for="pf-objetivo">Tu objetivo físico</label>
          <textarea id="pf-objetivo" maxlength="300" placeholder="Con tus palabras: qué quieres lograr">${v(perfil.objetivo_fisico)}</textarea></div>
        ${esPrimeraVez ? "" : `<span class="grupo-titulo">Tu mascota</span>
        <div class="opciones campo">
          <label><input type="radio" name="pf-masc" value="salchicha" ${(perfil.mascota || (perfil.tema === "azul" ? "chihuahua" : "salchicha")) === "salchicha" ? "checked" : ""}><span>🐕 Salchicha</span></label>
          <label><input type="radio" name="pf-masc" value="chihuahua" ${(perfil.mascota || (perfil.tema === "azul" ? "chihuahua" : "salchicha")) === "chihuahua" ? "checked" : ""}><span>🐶 Chihuahua</span></label>
        </div>
        <div class="campo"><label for="pf-masc-nombre">Nombre de tu mascota</label><input id="pf-masc-nombre" maxlength="30" value="${v(perfil.mascota_nombre)}" placeholder="Como tu perro"></div>`}
        <span class="grupo-titulo">Tu color en la app</span>
        <div class="opciones campo">
          <label class="op-rosa"><input type="radio" name="pf-tema" value="rosa" ${temaDefecto === "rosa" ? "checked" : ""}><span>Rosa</span></label>
          <label class="op-azul"><input type="radio" name="pf-tema" value="azul" ${temaDefecto === "azul" ? "checked" : ""}><span>Azul</span></label>
        </div>
        ${esPrimeraVez ? "" : `<label class="interruptor campo"><span>Compartir mis macros con mi pareja</span><input id="pf-macros" type="checkbox" ${perfil.compartir_macros ? "checked" : ""}></label>
        <p class="ayuda" style="margin:-10px 0 16px">Proteína, carbohidratos, azúcares, grasas y fibra. Las calorías nunca se comparten.</p>
        <label class="interruptor campo"><span>🤖 Coach con IA</span><input id="pf-coach" type="checkbox" ${perfil.coach_activo ? "checked" : ""}></label>
        <p class="ayuda" style="margin:-10px 0 16px">Comenta tus comidas, estima alimentos y responde dudas. Solo usa tus propios datos.</p>`}
        <button type="submit" class="boton-principal">${esPrimeraVez ? "Guardar y continuar" : "Guardar cambios"}</button>
        ${esPrimeraVez ? "" : `<button type="button" id="btn-salir" class="secundario">Cerrar sesión</button>`}
      </form>`;

    if (!esPrimeraVez) {
      $("vista").insertAdjacentHTML("beforeend", `<section class="tarjeta" id="avisos"><p class="vacio">Cargando…</p></section>`);
      pintarAvisos();
    }
    $("btn-salir")?.addEventListener("click", salir);
    $("form-perfil").addEventListener("submit", async (e) => {
      e.preventDefault();
      const datos = {
        nombre: $("pf-nombre").value.trim(),
        fecha_nacimiento: $("pf-nac").value || null,
        sexo: document.querySelector('input[name="pf-sexo"]:checked')?.value || null,
        estatura_cm: $("pf-estatura").value ? Number($("pf-estatura").value) : null,
        objetivo_fisico: $("pf-objetivo").value.trim() || null,
        tema: document.querySelector('input[name="pf-tema"]:checked')?.value || null,
        completado: true
      };
      if ($("pf-macros")) datos.compartir_macros = $("pf-macros").checked;
      if ($("pf-coach")) datos.coach_activo = $("pf-coach").checked;
      const masc = document.querySelector('input[name="pf-masc"]:checked');
      if (masc) { datos.mascota = masc.value; datos.mascota_nombre = $("pf-masc-nombre").value.trim() || null; }
      const peso = esPrimeraVez ? Number($("pf-peso").value) : null;
      if (!datos.nombre || !datos.fecha_nacimiento || !datos.sexo || !datos.estatura_cm || !datos.tema)
        return avisar("Completa nombre, fecha de nacimiento, sexo, estatura y color.");
      if (esPrimeraVez && !(peso >= 30 && peso <= 300)) return avisar("Escribe tu peso inicial en kg (entre 30 y 300).");
      const boton = e.submitter; boton.disabled = true;
      if (esPrimeraVez) {
        const m = await db.from("mediciones").insert({ fecha: yo().hoy, peso_kg: peso });
        if (m.error) { boton.disabled = false; return avisar(errorLegible(m.error)); }
      }
      const r = await db.from("perfiles").update(datos).eq("id", usuario.id);
      boton.disabled = false;
      if (r.error) return avisar(errorLegible(r.error));
      avisar("Perfil guardado.", "ok");
      if (esPrimeraVez) vistaActual = "metas";
      await recargar();
    });
  }

  // ================================================================ METAS
  const NUTRIENTES = [
    ["calorias", "Calorías", "kcal"], ["proteina", "Proteína", "g"], ["carbohidratos", "Carbohidratos", "g"],
    ["azucares", "Azúcares", "g"], ["grasas", "Grasas", "g"], ["fibra", "Fibra", "g"]
  ];

  async function vistaMetas() {
    const y = yo();
    const libre = antesDelInicio();
    const meses = [];
    for (let i = libre ? 0 : 1; i <= 3; i++) meses.push(sumarMeses(y.mes_actual, i));
    const semanas = [];
    for (let i = libre ? 0 : 1; i <= 6; i++) semanas.push(sumarDias(y.semana_actual, 7 * i));

    $("vista").innerHTML = `
      <h2 class="titulo">Metas</h2>
      <p class="sub">${libre
        ? "Antes del inicio del desafío puedes ajustar cualquier mes o semana."
        : "Solo se pueden cambiar meses y semanas que todavía no empezaron; lo ya empezado queda fijo."}</p>

      <section class="tarjeta" id="retos"><p class="vacio">Cargando retos…</p></section>

      <section class="tarjeta">
        <h3>Metas del mes</h3>
        <p>Se aplican desde la primera semana que pertenece al mes.</p>
        <label class="grupo-titulo" for="mm-mes" style="margin-top:16px">Mes</label>
        <select id="mm-mes" class="campo">${meses.map((m) => `<option value="${m}">${nombreMes(m)}</option>`).join("")}</select>
        <div id="mm-form"></div>
      </section>

      <section class="tarjeta">
        <h3>Metas de la semana</h3>
        <p>Días previstos de entrenamiento y horarios de sueño. Se configuran cada domingo para la semana siguiente.</p>
        <label class="grupo-titulo" for="ms-semana" style="margin-top:16px">Semana</label>
        <select id="ms-semana" class="campo">${semanas.map((s) => `<option value="${s}">Semana del ${fechaCorta(s)} (${fmt(mesMeta(s), { month: "long" })})</option>`).join("")}</select>
        <div id="ms-form"></div>
      </section>`;

    $("mm-mes").addEventListener("change", () => formMes($("mm-mes").value));
    $("ms-semana").addEventListener("change", () => formSemana($("ms-semana").value));
    formMes(meses[0]);
    formSemana(semanas[0]);
    seccionRetos($("retos"));
  }

  // ---------- Meta mensual
  function filasNutri(dia, mapa) {
    return NUTRIENTES.map(([k, nom, u]) => {
      const x = mapa[k];
      const tipo = x?.tipo || "";
      return `
        <div class="nutri" data-nutriente="${k}" data-dia="${dia}">
          <div class="cabecera-nutri">
          <span class="nombre-nutri">${nom} (${u})</span>
          <select aria-label="Tipo de objetivo de ${nom}">
            <option value="" ${!tipo ? "selected" : ""}>Sin objetivo</option>
            <option value="minimo" ${tipo === "minimo" ? "selected" : ""}>Mínimo</option>
            <option value="maximo" ${tipo === "maximo" ? "selected" : ""}>Máximo</option>
            <option value="rango" ${tipo === "rango" ? "selected" : ""}>Rango</option>
          </select>
          </div>
          <div class="valores">
            <input class="v-min" type="number" inputmode="decimal" min="0" placeholder="Mínimo" aria-label="${nom} mínimo" value="${x?.valor_min ?? ""}">
            <input class="v-max" type="number" inputmode="decimal" min="0" placeholder="Máximo" aria-label="${nom} máximo" value="${x?.valor_max ?? ""}">
          </div>
        </div>`;
    }).join("");
  }

  async function formMes(mes) {
    const cont = $("mm-form");
    cont.innerHTML = `<p class="sub">Cargando…</p>`;
    const [m, n] = await Promise.all([
      db.from("metas_mensuales").select("*").eq("user_id", usuario.id).lte("mes", mes).order("mes", { ascending: false }).limit(1),
      db.from("metas_nutricion").select("*").eq("user_id", usuario.id).lte("mes", mes).order("mes", { ascending: false })
    ]);
    if (m.error || n.error) return avisar(errorLegible(m.error || n.error));
    const base = m.data[0] || null;
    const mesNutri = n.data[0]?.mes;
    const delMes = n.data.filter((x) => x.mes === mesNutri);
    const nutri = Object.fromEntries(delMes.filter((x) => x.dia_tipo !== "descanso").map((x) => [x.nutriente, x]));
    const nutriDesc = Object.fromEntries(delMes.filter((x) => x.dia_tipo === "descanso").map((x) => [x.nutriente, x]));
    const distintas = Object.keys(nutriDesc).length > 0;
    const copia = base && base.mes !== mes;
    let entrenos = base?.entrenos_semana || 3;

    cont.innerHTML = `
      ${copia ? `<p class="aviso">Sin cambios guardados para este mes: se mantienen las metas de ${nombreMes(base.mes)}.</p>` : ""}
      <span class="grupo-titulo" style="margin-top:18px">Entrenamientos obligatorios por semana</span>
      <div class="contador">
        <button type="button" id="mm-menos" aria-label="Uno menos">−</button>
        <output id="mm-entrenos">${entrenos}</output>
        <button type="button" id="mm-mas" aria-label="Uno más">+</button>
      </div>
      <div class="fila">
        <div><label for="mm-libres">Comidas libres al mes</label><input id="mm-libres" type="number" inputmode="numeric" min="0" max="31" value="${base?.comidas_libres ?? 0}"></div>
        <div><label for="mm-alcohol">Bebidas por semana</label><input id="mm-alcohol" type="number" inputmode="numeric" min="0" max="50" placeholder="Sin límite" value="${base?.alcohol_bebidas_semana ?? ""}"></div>
      </div>
      <p class="ayuda">Deja las bebidas vacías si no quieres límite.</p>
      <span class="grupo-titulo" style="margin-top:18px">Regla de cantidad de comidas por día</span>
      <div class="fila">
        <select id="mm-regla-tipo" aria-label="Tipo de regla">
          <option value="" ${!base?.comidas_max && !base?.comidas_min ? "selected" : ""}>Sin regla</option>
          <option value="max" ${base?.comidas_max ? "selected" : ""}>Máximo</option>
          <option value="min" ${base?.comidas_min ? "selected" : ""}>Mínimo</option>
        </select>
        <input id="mm-regla-n" type="number" inputmode="numeric" min="1" max="12" value="${base?.comidas_max || base?.comidas_min || 3}" aria-label="Número de comidas">
      </div>
      <p class="ayuda">Ejemplo: máximo 3 (más de 3 resta en hábitos) o mínimo 3 (menos de 3 resta).</p>
      <hr class="separador">
      <span class="grupo-titulo">Objetivos diarios de nutrición</span>
      <p class="privado">🔒 Privados: solo tú los ves.</p>
      <label class="interruptor campo"><span>Metas distintas en días de descanso</span><input id="mm-distintas" type="checkbox" ${distintas ? "checked" : ""}></label>
      <p class="ayuda" style="margin:-10px 0 14px">Días de entreno: los previstos en tu plan o en los que entrenaste.</p>
      <span class="grupo-titulo" id="mm-titulo-principal">${distintas ? "🏋️ Días de entreno" : "Todos los días"}</span>
      ${filasNutri("principal", nutri)}
      <div id="mm-desc" ${distintas ? "" : "hidden"}>
        <span class="grupo-titulo" style="margin-top:16px">😌 Días de descanso</span>
        ${filasNutri("descanso", nutriDesc)}
      </div>
      <div class="campo" style="margin-top:16px"><label for="mm-agua">💧 Agua al día (ml)</label><input id="mm-agua" type="number" inputmode="numeric" min="0" max="8000" step="250" placeholder="Sin meta" value="${base?.agua_ml ?? ""}"></div>
      <button type="button" id="mm-guardar" class="boton-principal">Guardar metas de ${nombreMes(mes)}</button>`;

    const pintarValores = () => cont.querySelectorAll(".nutri").forEach((f) => {
      const t = f.querySelector("select").value;
      f.querySelector(".valores").hidden = !t;
      f.querySelector(".v-min").hidden = !(t === "minimo" || t === "rango");
      f.querySelector(".v-max").hidden = !(t === "maximo" || t === "rango");
    });
    pintarValores();
    cont.addEventListener("change", (e) => { if (e.target.matches(".nutri select")) pintarValores(); });
    $("mm-distintas").addEventListener("change", (e) => {
      $("mm-desc").hidden = !e.target.checked;
      $("mm-titulo-principal").textContent = e.target.checked ? "🏋️ Días de entreno" : "Todos los días";
    });

    $("mm-menos").onclick = () => { entrenos = Math.max(1, entrenos - 1); $("mm-entrenos").textContent = entrenos; };
    $("mm-mas").onclick = () => { entrenos = Math.min(7, entrenos + 1); $("mm-entrenos").textContent = entrenos; };

    $("mm-guardar").onclick = async (e) => {
      const nutricion = [];
      const distintasOn = $("mm-distintas").checked;
      for (const f of cont.querySelectorAll(".nutri")) {
        if (f.dataset.dia === "descanso" && !distintasOn) continue;
        const tipo = f.querySelector("select").value;
        if (!tipo) continue;
        const vmin = f.querySelector(".v-min").value, vmax = f.querySelector(".v-max").value;
        const nom = f.querySelector(".nombre-nutri").textContent;
        if ((tipo !== "maximo" && vmin === "") || (tipo !== "minimo" && vmax === "")) return avisar(`Completa el valor de ${nom}.`);
        if (tipo === "rango" && Number(vmin) > Number(vmax)) return avisar(`En ${nom}, el mínimo no puede ser mayor que el máximo.`);
        nutricion.push({ nutriente: f.dataset.nutriente, tipo, valor_min: tipo === "maximo" ? "" : vmin, valor_max: tipo === "minimo" ? "" : vmax,
          dia_tipo: !distintasOn ? "todos" : f.dataset.dia === "descanso" ? "descanso" : "entreno" });
      }
      const alcohol = $("mm-alcohol").value;
      e.target.disabled = true;
      const r = await db.rpc("guardar_meta_mensual", {
        p_mes: mes, p_entrenos: entrenos,
        p_libres: Number($("mm-libres").value || 0),
        p_alcohol: alcohol === "" ? null : Number(alcohol),
        p_nutricion: nutricion,
        p_comidas_max: $("mm-regla-tipo").value === "max" ? Number($("mm-regla-n").value) : null,
        p_comidas_min: $("mm-regla-tipo").value === "min" ? Number($("mm-regla-n").value) : null,
        p_agua_ml: $("mm-agua").value === "" ? null : Number($("mm-agua").value)
      });
      e.target.disabled = false;
      if (r.error) return avisar(errorLegible(r.error));
      avisar(`Metas de ${nombreMes(mes)} guardadas.`, "ok");
      const recargarEstado = await db.rpc("estado_general");
      if (!recargarEstado.error) estado = recargarEstado.data;
      formMes(mes);
    };
  }

  // ---------- Meta semanal
  async function formSemana(semana) {
    const cont = $("ms-form");
    cont.innerHTML = `<p class="sub">Cargando…</p>`;
    const [s, m] = await Promise.all([
      db.from("metas_semanales").select("*").eq("user_id", usuario.id).lte("semana", semana).order("semana", { ascending: false }).limit(1),
      db.from("metas_mensuales").select("entrenos_semana, mes").eq("user_id", usuario.id).lte("mes", mesMeta(semana)).order("mes", { ascending: false }).limit(1)
    ]);
    if (s.error || m.error) return avisar(errorLegible(s.error || m.error));
    const base = s.data[0] || null;
    const meta = m.data[0]?.entrenos_semana;
    if (!meta) {
      cont.innerHTML = `<p class="aviso">Primero guarda las metas de ${nombreMes(mesMeta(semana))}: esta semana pertenece a ese mes.</p>`;
      return;
    }
    const copia = base && base.semana !== semana;
    let dias = new Set(base?.dias_previstos || []);
    const hhmm = (t) => (t ? t.slice(0, 5) : "");
    // Si los valores vienen guardados, no se autocompletan
    const manual = { ds: !!base, ws: !!base, df: !!base, wf: !!base };

    cont.innerHTML = `
      ${copia ? `<p class="aviso">Sin cambios guardados para esta semana: se mantiene el plan del ${fechaCorta(base.semana)}.</p>` : ""}
      <span class="grupo-titulo" style="margin-top:18px">Días previstos de entrenamiento</span>
      <div class="selector-dias" role="group" aria-label="Días previstos">
        ${DIAS.map((d, i) => `<button type="button" data-dia="${i + 1}" aria-pressed="${dias.has(i + 1)}">${d}</button>`).join("")}
      </div>
      <p class="ayuda" id="ms-ayuda-dias" style="margin:8px 0 22px"></p>

      <span class="grupo-titulo">Horarios de sueño</span>
      <p class="ayuda" style="margin:-2px 0 12px">Al elegir una hora, sugerimos la otra para completar 8 horas. Cada par debe sumar entre 6 y 10 horas.</p>
      ${parSueno("Noches de domingo a jueves", "Despiertas de lunes a viernes", "ms-ds", "ms-ws", hhmm(base?.dormir_semana), hhmm(base?.despertar_semana))}
      ${parSueno("Noches de viernes y sábado", "Despiertas sábado y domingo", "ms-df", "ms-wf", hhmm(base?.dormir_finde), hhmm(base?.despertar_finde))}
      <button type="button" id="ms-guardar" class="boton-principal">Guardar semana del ${fechaCorta(semana)}</button>`;

    const ayudaDias = () => {
      const ok = dias.size >= meta;
      const el = $("ms-ayuda-dias");
      el.textContent = `Tu meta es de ${meta} entrenamientos: elige al menos ${meta} días. Los demás son descanso.` + (ok ? "" : ` Faltan ${meta - dias.size}.`);
      el.style.color = ok ? "" : "#A3402B";
    };
    ayudaDias();

    cont.querySelector(".selector-dias").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-dia]"); if (!b) return;
      const d = Number(b.dataset.dia);
      dias.has(d) ? dias.delete(d) : dias.add(d);
      b.setAttribute("aria-pressed", dias.has(d));
      ayudaDias();
    });

    const pares = [["ms-ds", "ms-ws"], ["ms-df", "ms-wf"]];
    const pintarDuracion = (a, b) => {
      const d = duracion($(a).value, $(b).value);
      const el = $(a + "-dur");
      if (d === null) { el.textContent = ""; return; }
      const ok = d >= SUENO.min && d <= SUENO.max;
      el.textContent = (ok ? "Total: " : "Fuera de rango: ") + textoDuracion(d);
      el.className = "duracion" + (ok ? "" : " mal");
    };
    for (const [a, b] of pares) {
      const ka = a.slice(3), kb = b.slice(3);
      $(a).addEventListener("input", () => {
        manual[ka] = true;
        if (!manual[kb] && $(a).value) $(b).value = aHora(aMin($(a).value) + SUENO.sugerido);
        pintarDuracion(a, b);
      });
      $(b).addEventListener("input", () => {
        manual[kb] = true;
        if (!manual[ka] && $(b).value) $(a).value = aHora(aMin($(b).value) - SUENO.sugerido);
        pintarDuracion(a, b);
      });
      pintarDuracion(a, b);
    }

    $("ms-guardar").onclick = async (e) => {
      if (dias.size < meta) return avisar(`Elige al menos ${meta} días previstos.`);
      for (const [a, b] of pares) {
        if (!$(a).value || !$(b).value) return avisar("Completa los cuatro horarios de sueño.");
        const d = duracion($(a).value, $(b).value);
        if (d < SUENO.min || d > SUENO.max) return avisar("Cada horario de sueño debe sumar entre 6 y 10 horas.");
      }
      e.target.disabled = true;
      const r = await db.from("metas_semanales").upsert({
        user_id: usuario.id, semana,
        dias_previstos: [...dias].sort(),
        dormir_semana: $("ms-ds").value, despertar_semana: $("ms-ws").value,
        dormir_finde: $("ms-df").value, despertar_finde: $("ms-wf").value
      }, { onConflict: "user_id,semana" });
      e.target.disabled = false;
      if (r.error) return avisar(errorLegible(r.error));
      avisar(`Semana del ${fechaCorta(semana)} guardada.`, "ok");
      const recargarEstado = await db.rpc("estado_general");
      if (!recargarEstado.error) estado = recargarEstado.data;
      formSemana(semana);
    };
  }

  function parSueno(titulo, detalle, id1, id2, v1, v2) {
    return `
      <div class="par-sueno">
        <span class="grupo-titulo">${titulo}</span>
        <p class="ayuda" style="margin:-6px 0 12px">${detalle}</p>
        <div class="fila">
          <div><label for="${id1}">😴 Dormir</label><input id="${id1}" type="time" value="${v1}"></div>
          <div><label for="${id2}">⏰ Despertar</label><input id="${id2}" type="time" value="${v2}"></div>
        </div>
        <p class="duracion" id="${id1}-dur"></p>
      </div>`;
  }

  // ================================================================ ENTRENAMIENTOS (fase 2)
  const TIPOS = [
    ["musculacion", "🏋️‍♀️", "Musculación"], ["funcional", "⚡", "Funcional"], ["correr", "🏃", "Correr"],
    ["natacion", "🏊", "Natación"], ["ciclismo", "🚴", "Ciclismo"], ["senderismo", "🥾", "Senderismo"],
    ["caminadora", "⛰️", "Caminadora inclinada"], ["escalada", "🧗", "Escalada"], ["yoga", "🧘", "Yoga"],
    ["pilates", "🤸‍♀️", "Pilates"], ["otro", "✨", "Otro"]
  ];
  const TIPO = Object.fromEntries(TIPOS.map(([k, e, n]) => [k, { emoji: e, nombre: n }]));
  const CON_DISTANCIA = ["correr", "natacion", "ciclismo", "senderismo", "caminadora"];
  const CON_ZONAS = ["musculacion", "funcional"];
  const ZONAS_CUERPO = [["upper", "Upper body"], ["lower", "Lower body"], ["full", "Cuerpo completo"], ["pecho", "Pecho"],
    ["espalda", "Espalda"], ["hombros", "Hombros"], ["brazos", "Brazos"], ["core", "Core"], ["gluteos", "Glúteos"], ["piernas", "Piernas"]];
  const ZONA_NOMBRE = Object.fromEntries(ZONAS_CUERPO);
  const ANIMOS = [["satisfecho", "😌", "Satisfecho"], ["feliz", "😄", "Feliz"], ["decepcionado", "😞", "Decepcionado"],
    ["frustrado", "😤", "Frustrado"], ["agotado", "🫠", "Agotado"]];
  const ANIMO = Object.fromEntries(ANIMOS.map(([k, e, n]) => [k, { emoji: e, nombre: n }]));
  const MIN_VALIDO = 20; // duración mínima para contar (la base de datos usa el ajuste 'duracion_minima_min')
  const MET = { musculacion: 5.0, funcional: 6.0, natacion: 7.0, senderismo: 6.0, caminadora: 6.0, escalada: 7.5, yoga: 2.5, pilates: 3.0, otro: 4.0 };

  // Calorías estimadas con la fórmula MET: kcal = MET × peso (kg) × horas
  function estimarKcal(tipo, minutos, km, pesoKg) {
    if (!tipo || !minutos || !pesoKg) return null;
    let met = MET[tipo];
    const kmh = km ? km / (minutos / 60) : null;
    if (tipo === "correr") met = kmh ? Math.min(16, Math.max(6, kmh)) : 9;
    if (tipo === "ciclismo") met = !kmh ? 7.5 : kmh < 16 ? 4 : kmh < 19 ? 6.8 : kmh < 22 ? 8 : 10;
    return Math.round(met * pesoKg * (minutos / 60));
  }

  function idYoutube(texto) {
    const m = String(texto || "").match(/(?:youtu\.be\/|v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{11}$/.test(String(texto || "").trim()) ? texto.trim() : null;
  }
  async function datosYoutube(id) {
    const url = encodeURIComponent("https://www.youtube.com/watch?v=" + id);
    for (const fuente of [`https://www.youtube.com/oembed?format=json&url=${url}`, `https://noembed.com/embed?url=${url}`]) {
      try {
        const r = await fetch(fuente);
        if (r.ok) { const j = await r.json(); if (j.title) return { titulo: j.title, canal: j.author_name || null }; }
      } catch (_) { /* se intenta la siguiente fuente */ }
    }
    return null;
  }
  const miniaturaYoutube = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  const enlaceYoutube = (id) => `https://www.youtube.com/watch?v=${id}`;

  // Compresión de fotos en el teléfono antes de subirlas
  async function comprimir(file, maxLado, calidad) {
    let fuente;
    try { fuente = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch (_) {
      fuente = await new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = URL.createObjectURL(file); });
    }
    const w = fuente.width, h = fuente.height, k = Math.min(1, maxLado / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext("2d").drawImage(fuente, 0, 0, c.width, c.height);
    return new Promise((ok) => c.toBlob(ok, "image/jpeg", calidad));
  }

  async function urlsFirmadas(rutas) {
    if (!rutas.length) return {};
    const { data } = await db.storage.from("evidencias").createSignedUrls(rutas, 3600);
    return Object.fromEntries((data || []).filter((x) => x.signedUrl).map((x) => [x.path, x.signedUrl]));
  }

  const etiquetaFecha = (iso) => {
    const hoy = yo().hoy;
    if (iso === hoy) return "Hoy";
    if (iso === sumarDias(hoy, -1)) return "Ayer";
    return fmt(iso, { weekday: "short", day: "numeric", month: "short" });
  };

  function resumenEntreno(e) {
    const partes = [`${e.duracion_min} min`];
    if (e.distancia_km) partes.push(`${Number(e.distancia_km)} km`);
    if (e.zonas?.length) partes.push(e.zonas.map((z) => ZONA_NOMBRE[z] || z).join(", "));
    return partes.join(" · ");
  }
  const nombreTipo = (e) => e.tipo === "otro" ? (e.tipo_otro || "Otro") : TIPO[e.tipo].nombre;

  function textoSemana(y, dias, meta) {
    const total = y.entrenos_semana ?? 0, validos = y.entrenos_validos ?? total, cortos = total - validos;
    let t = `${validos} entrenamiento${validos === 1 ? "" : "s"} válido${validos === 1 ? "" : "s"}`;
    if (cortos > 0) t += ` · ${cortos} de menos de ${MIN_VALIDO} min (no cuenta${cortos === 1 ? "" : "n"})`;
    if (meta && dias > meta) t += ` · ${dias - meta} día${dias - meta === 1 ? "" : "s"} adicional${dias - meta === 1 ? "" : "es"}`;
    return t + ".";
  }

  // ---------- Vista Entrenar
  let entrenarDe = "yo";
  async function vistaEntrenar() {
    const y = yo(), p = pareja();
    const meta = y.meta_mes ? metaEfectiva(y) : 0;
    const dias = (y.dias_entrenados || []).length;
    const pct = meta ? Math.min(100, Math.round((dias / meta) * 100)) : 0;
    $("vista").innerHTML = `
      <h2 class="titulo">Entrenar</h2>
      <p class="sub">Semana del ${fechaCorta(y.semana_actual)}</p>
      <section class="tarjeta">
        <h3>Esta semana</h3>
        <div class="cifra">${Math.min(dias, meta || dias)}<small> de ${meta || "—"} días con entrenamiento</small></div>
        <div class="progreso"><span style="width:${pct}%"></span></div>
        <p>${textoSemana(y, dias, meta)}</p>
        <button type="button" class="boton-principal" data-accion="registrar" style="margin-top:16px">Registrar entrenamiento</button>
      </section>
      <div id="importados"></div>
      ${tarjetaCambios()}
      <div id="por-responder"></div>
      <div id="pendientes-juntos"></div>
      <div class="segmentado" role="group" aria-label="Ver entrenamientos de">
        <button type="button" data-ver="yo" aria-pressed="${entrenarDe === "yo"}">Mi semana</button>
        <button type="button" data-ver="pareja" aria-pressed="${entrenarDe === "pareja"}">${esc(p?.nombre || "Pareja")}</button>
      </div>
      <div id="lista-entrenos" class="lista"><p class="vacio">Cargando…</p></div>
      <h3 style="margin:26px 0 10px">Rutinas de YouTube</h3>
      <div id="lista-rutinas" class="lista"><p class="vacio">Cargando…</p></div>`;
    cargarListaEntrenos();
    cargarPendientesJuntos($("pendientes-juntos"));
    cargarPorResponder($("por-responder"));
    cargarImportados();
    cargarRutinas();
  }

  async function cargarListaEntrenos() {
    const quien = entrenarDe === "yo" ? yo() : pareja();
    const cont = $("lista-entrenos");
    if (!quien) { cont.innerHTML = ""; return; }
    const { data, error } = await db.from("entrenos")
      .select("*, evidencias(ruta, miniatura), rutinas_youtube(video_id, titulo), disputas(estado)")
      .eq("user_id", quien.id).eq("estado", "completado")
      .gte("fecha", quien.semana_actual).lte("fecha", sumarDias(quien.semana_actual, 6))
      .order("fecha", { ascending: false }).order("hora", { ascending: false });
    if (error) { cont.innerHTML = ""; return avisar(errorLegible(error)); }
    if (!data.length) {
      cont.innerHTML = `<p class="vacio">${entrenarDe === "yo" ? "Todavía no registraste entrenamientos esta semana." : "Aún no hay entrenamientos esta semana."}</p>`;
      return;
    }
    const urls = await urlsFirmadas(data.map((e) => e.evidencias[0]?.miniatura).filter(Boolean));
    cont.innerHTML = data.map((e) => {
      const mini = e.evidencias[0] ? urls[e.evidencias[0].miniatura] : null;
      return `
      <button type="button" class="item" data-entreno="${e.id}">
        <span class="mini" ${mini ? `style="background-image:url('${mini}')"` : ""}>${mini ? "" : TIPO[e.tipo].emoji}</span>
        <span><strong>${TIPO[e.tipo].emoji} ${esc(nombreTipo(e))}</strong>
          <span class="meta">${etiquetaFecha(e.fecha)}${e.hora ? " · " + e.hora.slice(0, 5) : ""} · ${esc(resumenEntreno(e))}</span>
          ${e.juntos === "confirmado" ? `<span class="etiqueta">💞 Juntos</span>` : e.juntos === "pendiente" ? `<span class="etiqueta">Juntos: por confirmar</span>` : ""}
          ${e.recuperacion ? `<span class="etiqueta">En recuperación</span>` : ""}
          ${e.duracion_min < MIN_VALIDO ? `<span class="etiqueta etiqueta-aviso">No cuenta: menos de ${MIN_VALIDO} min</span>` : ""}
          ${e.disputas?.estado === "activa" ? `<span class="etiqueta etiqueta-aviso">⚠️ Evidencia disputada</span>` : ""}
        </span>
        <span class="lado">${e.animo ? ANIMO[e.animo].emoji : ""}</span>
      </button>`;
    }).join("");
  }

  async function cargarPendientesJuntos(cont) {
    const p = pareja();
    if (!p || !cont) return;
    const { data } = await db.from("entrenos").select("id, tipo, tipo_otro, fecha, duracion_min")
      .eq("user_id", p.id).eq("juntos", "pendiente").eq("estado", "completado")
      .gte("fecha", sumarDias(yo().hoy, -3));
    if (!data?.length) { cont.innerHTML = ""; return; }
    cont.innerHTML = data.map((e) => `
      <section class="tarjeta">
        <h3>¿Entrenaron juntos?</h3>
        <p>${esc(p.nombre)} registró ${TIPO[e.tipo].emoji} ${esc(nombreTipo(e))} (${e.duracion_min} min, ${etiquetaFecha(e.fecha).toLowerCase()}) como entrenamiento juntos.</p>
        <div class="acciones-juntos">
          <button type="button" data-entreno-juntos="si" data-id="${e.id}">Confirmar</button>
          <button type="button" class="secundario" style="margin:0" data-entreno-juntos="no" data-id="${e.id}">No fue juntos</button>
        </div>
      </section>`).join("");
  }

  async function cargarRutinas() {
    const cont = $("lista-rutinas");
    const { data, error } = await db.from("rutinas_youtube").select("*").eq("user_id", usuario.id)
      .order("favorito", { ascending: false }).order("creado_en", { ascending: false }).limit(12);
    if (error) { cont.innerHTML = ""; return; }
    if (!data.length) {
      cont.innerHTML = `<p class="vacio">Cuando registres un entrenamiento con un enlace de YouTube, la rutina se guardará aquí para repetirla.</p>`;
      return;
    }
    cont.innerHTML = data.map((r) => `
      <div class="tarjeta" style="margin:0">
        <div class="yt">
          <img src="${miniaturaYoutube(r.video_id)}" alt="" loading="lazy">
          <div>
            <strong>${esc(r.titulo || "Rutina sin título")}</strong>
            <div class="estrellas" role="group" aria-label="Calificación">
              ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="${(r.calificacion || 0) >= n ? "on" : ""}" data-rutina-cal="${n}" data-id="${r.id}" aria-label="${n} de 5">★</button>`).join("")}
            </div>
          </div>
        </div>
        <div class="acciones-fila">
          <a href="${enlaceYoutube(r.video_id)}" target="_blank" rel="noopener">▶ Abrir</a>
          <button type="button" data-rutina-usar="${r.id}">Usar en un entrenamiento</button>
          <button type="button" data-rutina-fav="${r.id}" data-fav="${r.favorito}">${r.favorito ? "♥ Favorita" : "♡ Favorita"}</button>
        </div>
      </div>`).join("");
  }

  // ---------- Registrar entrenamiento
  async function vistaRegistrar(rutinaInicial) {
    vistaActual = "registrar";
    const y = yo();
    const ahora = new Date();
    const ayerPermitido = ahora.getHours() < 12 || antesDelInicio();
    const f = { tipo: null, fecha: y.hoy, zonas: new Set(), animo: null, recuperacion: null, fotos: [] };
    const [pesoR, rutinasR] = await Promise.all([
      db.from("mediciones").select("peso_kg").eq("user_id", usuario.id).not("peso_kg", "is", null).order("fecha", { ascending: false }).limit(1),
      db.from("rutinas_youtube").select("id, video_id, titulo").eq("user_id", usuario.id).order("favorito", { ascending: false }).order("creado_en", { ascending: false })
    ]);
    const peso = pesoR.data?.[0]?.peso_kg ? Number(pesoR.data[0].peso_kg) : null;
    const rutinas = rutinasR.data || [];
    const hora = String(ahora.getHours()).padStart(2, "0") + ":" + String(ahora.getMinutes()).padStart(2, "0");

    $("vista").innerHTML = `
      <div class="cabecera-vista"><h2 class="titulo">Registrar</h2><button type="button" data-accion="volver-entrenar">Cancelar</button></div>
      <p class="sub">Sin al menos una foto de evidencia no se puede guardar.</p>

      <section class="tarjeta">
        <span class="grupo-titulo">Tipo de entrenamiento</span>
        <div class="tipos" id="rg-tipos">${TIPOS.map(([k, e, n]) => `<button type="button" data-tipo="${k}" aria-pressed="false"><span>${e}</span>${n}</button>`).join("")}</div>
        <div id="rg-otro" class="campo" hidden style="margin-top:14px"><label for="rg-otro-nombre">¿Qué actividad?</label><input id="rg-otro-nombre" maxlength="60"></div>
      </section>

      <section class="tarjeta">
        <span class="grupo-titulo">Cuándo</span>
        <div class="opciones campo">
          <label><input type="radio" name="rg-fecha" value="${y.hoy}" checked><span>Hoy</span></label>
          ${ayerPermitido ? `<label><input type="radio" name="rg-fecha" value="${sumarDias(y.hoy, -1)}"><span>Ayer</span></label>` : ""}
        </div>
        <div class="fila">
          <div><label for="rg-hora">Hora</label><input id="rg-hora" type="time" value="${hora}"></div>
          <div><label for="rg-duracion">Duración (min)</label><input id="rg-duracion" type="number" inputmode="numeric" min="1" max="600"></div>
        </div>
        <p class="ayuda" id="rg-aviso-duracion"></p>
        <div id="rg-distancia" class="campo" hidden style="margin-top:14px"><label for="rg-km">Distancia (km)</label><input id="rg-km" type="number" inputmode="decimal" min="0" step="0.01"></div>
        <div id="rg-zonas" hidden style="margin-top:14px"><span class="grupo-titulo">Zonas trabajadas</span>
          <div class="chips">${ZONAS_CUERPO.map(([k, n]) => `<button type="button" data-zona="${k}" aria-pressed="false">${n}</button>`).join("")}</div></div>
        <div class="kcal" id="rg-kcal" hidden></div>
      </section>

      <section class="tarjeta">
        <span class="grupo-titulo">Evidencia (1 a 3 fotos)</span>
        <div class="fotos" id="rg-fotos"></div>
      </section>

      <section class="tarjeta">
        <span class="grupo-titulo">Rutina de YouTube (opcional)</span>
        ${rutinas.length ? `<select id="rg-rutina" class="campo"><option value="">Ninguna o un enlace nuevo</option>${rutinas.map((r) => `<option value="${r.id}" ${rutinaInicial == r.id ? "selected" : ""}>${esc(r.titulo || r.video_id)}</option>`).join("")}</select>` : ""}
        <div id="rg-yt-nuevo">
          <label for="rg-yt">Enlace del video</label>
          <input id="rg-yt" type="url" inputmode="url" placeholder="https://youtu.be/…" autocapitalize="off">
          <div id="rg-yt-info" style="margin-top:12px"></div>
        </div>
      </section>

      <section class="tarjeta">
        <label class="interruptor"><span>Entrenamos juntos</span><input id="rg-juntos" type="checkbox"></label>
        <p class="ayuda">Tu pareja tendrá que confirmarlo.</p>
        <span class="grupo-titulo" style="margin-top:18px">¿Entrenas en recuperación?</span>
        <div class="chips" id="rg-recuperacion">
          <button type="button" data-rec="" aria-pressed="true">No</button>
          <button type="button" data-rec="lesion" aria-pressed="false">De una lesión</button>
          <button type="button" data-rec="enfermedad" aria-pressed="false">De una enfermedad</button>
        </div>
        <div class="campo" style="margin-top:18px"><label for="rg-notas">Notas</label><textarea id="rg-notas" maxlength="1000" placeholder="Ejercicios, pesos, sensaciones…"></textarea></div>
      </section>

      <section class="tarjeta">
        <span class="grupo-titulo">¿Cómo te sientes? (opcional)</span>
        <div class="chips" id="rg-animo">${ANIMOS.map(([k, e, n]) => `<button type="button" data-animo="${k}" aria-pressed="false">${e} ${n}</button>`).join("")}</div>
        <div class="campo" id="rg-animo-nota-c" hidden style="margin-top:14px"><label for="rg-animo-nota">¿Por qué te sientes así?</label><textarea id="rg-animo-nota" maxlength="500"></textarea></div>
      </section>

      <button type="button" id="rg-guardar" class="boton-principal">Guardar entrenamiento</button>
      <button type="button" class="secundario" data-accion="volver-entrenar">Cancelar</button>`;

    const pulsar = (cont, sel, valor, multiple) => cont.querySelectorAll(sel).forEach((b) => {
      if (!multiple) b.setAttribute("aria-pressed", b === valor);
    });

    // Tipo
    $("rg-tipos").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-tipo]"); if (!b) return;
      f.tipo = b.dataset.tipo;
      pulsar($("rg-tipos"), "button", b);
      $("rg-otro").hidden = f.tipo !== "otro";
      $("rg-distancia").hidden = !CON_DISTANCIA.includes(f.tipo);
      $("rg-zonas").hidden = !CON_ZONAS.includes(f.tipo);
      calcular();
    });
    // Zonas
    $("rg-zonas").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-zona]"); if (!b) return;
      f.zonas.has(b.dataset.zona) ? f.zonas.delete(b.dataset.zona) : f.zonas.add(b.dataset.zona);
      b.setAttribute("aria-pressed", f.zonas.has(b.dataset.zona));
    });
    // Recuperación y ánimo
    $("rg-recuperacion").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-rec]"); if (!b) return;
      f.recuperacion = b.dataset.rec || null; pulsar($("rg-recuperacion"), "button", b);
    });
    $("rg-animo").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-animo]"); if (!b) return;
      f.animo = f.animo === b.dataset.animo ? null : b.dataset.animo;
      $("rg-animo").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.animo === f.animo));
      $("rg-animo-nota-c").hidden = !f.animo;
    });

    // Calorías y aviso de duración
    function calcular() {
      const min = Number($("rg-duracion").value) || 0;
      const aviso = $("rg-aviso-duracion");
      aviso.textContent = min && min < MIN_VALIDO ? `Con menos de ${MIN_VALIDO} minutos se guarda, pero no cuenta para tu meta semanal.` : "";
      const kcal = estimarKcal(f.tipo, min, Number($("rg-km").value) || null, peso);
      $("rg-kcal").hidden = !kcal;
      if (kcal) $("rg-kcal").textContent = `🔒 Aproximadamente ${kcal} kcal quemadas (estimación privada).`;
    }
    $("rg-duracion").addEventListener("input", calcular);
    $("rg-km").addEventListener("input", calcular);

    // Fotos
    function pintarFotos() {
      $("rg-fotos").innerHTML = f.fotos.map((x, i) => `<div class="foto" style="background-image:url('${x.url}')"><button type="button" data-quitar="${i}" aria-label="Quitar foto">×</button></div>`).join("") +
        (f.fotos.length < 3 ? `<label class="agregar-foto"><input type="file" accept="image/*" multiple id="rg-archivo">📷<br>Agregar foto</label>` : "");
      $("rg-archivo")?.addEventListener("change", (e) => {
        for (const file of [...e.target.files].slice(0, 3 - f.fotos.length)) f.fotos.push({ file, url: URL.createObjectURL(file) });
        pintarFotos();
      });
    }
    $("rg-fotos").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-quitar]"); if (!b) return;
      f.fotos.splice(Number(b.dataset.quitar), 1); pintarFotos();
    });
    pintarFotos();

    // YouTube
    let yt = null; // { id, titulo, canal }
    const ytSel = $("rg-rutina");
    const actualizarYt = () => { $("rg-yt-nuevo").hidden = !!(ytSel && ytSel.value); };
    ytSel?.addEventListener("change", actualizarYt); actualizarYt();
    let tYt;
    $("rg-yt").addEventListener("input", () => {
      clearTimeout(tYt);
      tYt = setTimeout(async () => {
        const id = idYoutube($("rg-yt").value);
        const info = $("rg-yt-info");
        if (!id) { yt = null; info.innerHTML = $("rg-yt").value ? `<p class="ayuda">No reconozco ese enlace de YouTube.</p>` : ""; return; }
        info.innerHTML = `<p class="ayuda">Buscando el video…</p>`;
        const d = await datosYoutube(id);
        yt = { id, titulo: d?.titulo || "", canal: d?.canal || null };
        info.innerHTML = `<div class="yt"><img src="${miniaturaYoutube(id)}" alt=""><div>
          <label for="rg-yt-titulo" style="font-weight:500;font-size:.85rem;color:var(--texto-suave)">Título</label>
          <input id="rg-yt-titulo" maxlength="200" value="${esc(yt.titulo)}" placeholder="Nombre de la rutina"></div></div>`;
      }, 400);
    });

    // Guardar
    $("rg-guardar").addEventListener("click", async (ev) => {
      const boton = ev.target;
      const duracion = Number($("rg-duracion").value);
      if (!f.tipo) return avisar("Elige el tipo de entrenamiento.");
      if (f.tipo === "otro" && !$("rg-otro-nombre").value.trim()) return avisar("Escribe qué actividad hiciste.");
      if (!(duracion >= 1 && duracion <= 600)) return avisar("Escribe la duración en minutos.");
      if (!f.fotos.length) return avisar("Agrega al menos una foto de evidencia.");
      const fecha = document.querySelector('input[name="rg-fecha"]:checked').value;
      const km = CON_DISTANCIA.includes(f.tipo) && $("rg-km").value ? Number($("rg-km").value) : null;
      boton.disabled = true;
      const paso = (t) => (boton.textContent = t);
      let entrenoId = null;
      try {
        // 1. Rutina de YouTube
        let rutinaId = ytSel?.value ? Number(ytSel.value) : null;
        if (!rutinaId && yt) {
          const titulo = $("rg-yt-titulo")?.value.trim() || yt.titulo || null;
          const r = await db.from("rutinas_youtube")
            .upsert({ user_id: usuario.id, video_id: yt.id, titulo, canal: yt.canal }, { onConflict: "user_id,video_id" })
            .select("id").single();
          if (r.error) throw r.error;
          rutinaId = r.data.id;
        }
        // 2. Entrenamiento como borrador
        paso("Guardando…");
        const r1 = await db.from("entrenos").insert({
          user_id: usuario.id, fecha, hora: $("rg-hora").value || null, duracion_min: duracion,
          tipo: f.tipo, tipo_otro: f.tipo === "otro" ? $("rg-otro-nombre").value.trim() : null,
          distancia_km: km, zonas: CON_ZONAS.includes(f.tipo) ? [...f.zonas] : [],
          notas: $("rg-notas").value.trim() || null, rutina_id: rutinaId,
          juntos: $("rg-juntos").checked ? "pendiente" : "no",
          animo: f.animo, animo_nota: f.animo ? ($("rg-animo-nota").value.trim() || null) : null,
          recuperacion: f.recuperacion
        }).select("id").single();
        if (r1.error) throw r1.error;
        entrenoId = r1.data.id;
        // 3. Fotos comprimidas + miniaturas
        for (let i = 0; i < f.fotos.length; i++) {
          paso(`Subiendo foto ${i + 1} de ${f.fotos.length}…`);
          const base = `${usuario.id}/${entrenoId}/${Date.now()}-${i}`;
          const [grande, mini] = await Promise.all([comprimir(f.fotos[i].file, 1280, 0.72), comprimir(f.fotos[i].file, 360, 0.7)]);
          for (const [ruta, blob] of [[base + ".jpg", grande], [base + "-mini.jpg", mini]]) {
            const up = await db.storage.from("evidencias").upload(ruta, blob, { contentType: "image/jpeg", upsert: false });
            if (up.error) throw up.error;
          }
          const ev = await db.from("evidencias").insert({ entreno_id: entrenoId, user_id: usuario.id, ruta: base + ".jpg", miniatura: base + "-mini.jpg" });
          if (ev.error) throw ev.error;
        }
        // 4. Completar
        paso("Completando…");
        const r2 = await db.from("entrenos").update({ estado: "completado" }).eq("id", entrenoId);
        if (r2.error) throw r2.error;
        // 5. Calorías privadas
        const kcal = estimarKcal(f.tipo, duracion, km, peso);
        if (kcal) await db.from("entrenos_privado").insert({ entreno_id: entrenoId, user_id: usuario.id, kcal_est: kcal });
        avisar("Entrenamiento guardado. ¡Bien hecho! 💪", "ok");
        await recargarEstado();
        irA("entrenar");
      } catch (err) {
        if (entrenoId) await db.from("entrenos").delete().eq("id", entrenoId);
        boton.disabled = false; paso("Guardar entrenamiento");
        avisar("No se pudo guardar: " + errorLegible(err));
      }
    });
  }

  // ---------- Detalle (hoja inferior)
  function abrirHoja(html) {
    $("hoja-contenido").innerHTML = `<div class="asa"></div>` + html;
    $("hoja").hidden = false;
    document.body.style.overflow = "hidden";
  }
  function cerrarHoja() {
    $("hoja").hidden = true;
    document.body.style.overflow = "";
  }
  $("hoja").addEventListener("click", (e) => {
    if (e.target === $("hoja") || e.target.closest("[data-cerrar-hoja]")) cerrarHoja();
  });

  async function verEntreno(id) {
    const { data: e, error } = await db.from("entrenos")
      .select("*, evidencias(ruta), rutinas_youtube(video_id, titulo), entrenos_privado(kcal_est), disputas(*)").eq("id", id).single();
    if (error) return avisar(errorLegible(error));
    const urls = await urlsFirmadas(e.evidencias.map((x) => x.ruta));
    const esMio = e.user_id === usuario.id;
    const duenio = estado.participantes.find((x) => x.id === e.user_id);
    const editable = esMio && (e.fecha === yo().hoy || antesDelInicio() || (e.fecha === sumarDias(yo().hoy, -1) && new Date().getHours() < 12));
    const kcal = Array.isArray(e.entrenos_privado) ? e.entrenos_privado[0]?.kcal_est : e.entrenos_privado?.kcal_est;
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.6rem">${TIPO[e.tipo].emoji} ${esc(nombreTipo(e))}</h2>
        <button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub" style="margin-bottom:8px">${esc(duenio?.nombre || "")} · ${etiquetaFecha(e.fecha)}${e.hora ? " · " + e.hora.slice(0, 5) : ""}</p>
      <p style="margin:0">${esc(resumenEntreno(e))}</p>
      ${e.juntos === "confirmado" ? `<span class="etiqueta">💞 Entrenaron juntos</span>` : e.juntos === "pendiente" ? `<span class="etiqueta">Juntos: por confirmar</span>` : e.juntos === "rechazado" ? `<span class="etiqueta">Juntos: no confirmado</span>` : ""}
      ${e.recuperacion ? `<span class="etiqueta">En recuperación de ${e.recuperacion === "lesion" ? "una lesión" : "una enfermedad"}</span>` : ""}
      ${e.duracion_min < MIN_VALIDO ? `<span class="etiqueta etiqueta-aviso">No cuenta para la meta: menos de ${MIN_VALIDO} min</span>` : ""}
      <div class="galeria">${e.evidencias.map((x) => urls[x.ruta] ? `<img src="${urls[x.ruta]}" alt="Evidencia">` : "").join("")}</div>
      ${e.animo ? `<section class="tarjeta"><h3>${ANIMO[e.animo].emoji} ${ANIMO[e.animo].nombre}</h3>${e.animo_nota ? `<p>${esc(e.animo_nota)}</p>` : ""}</section>` : ""}
      ${e.rutinas_youtube ? `<section class="tarjeta"><div class="yt"><img src="${miniaturaYoutube(e.rutinas_youtube.video_id)}" alt=""><div><strong>${esc(e.rutinas_youtube.titulo || "Rutina de YouTube")}</strong>
        <div class="acciones-fila"><a href="${enlaceYoutube(e.rutinas_youtube.video_id)}" target="_blank" rel="noopener">▶ Abrir</a></div></div></div></section>` : ""}
      ${e.notas ? `<section class="tarjeta"><h3>Notas</h3><p>${esc(e.notas)}</p></section>` : ""}
      ${esMio && kcal ? `<div class="kcal">🔒 Aproximadamente ${kcal} kcal quemadas (solo tú lo ves).</div>` : ""}
      ${!esMio && e.juntos === "pendiente" ? `<div class="acciones-juntos"><button type="button" data-entreno-juntos="si" data-id="${e.id}">Confirmar que fue juntos</button>
        <button type="button" class="secundario" style="margin:0" data-entreno-juntos="no" data-id="${e.id}">No fue juntos</button></div>` : ""}
      ${e.disputas?.estado === "activa" ? `<section class="tarjeta"><h3>⚠️ Evidencia disputada</h3><p>${esc(e.disputas.nota)}</p><p class="ayuda">Mientras la disputa esté activa, este entrenamiento no cuenta.</p>
        ${e.disputas.disputado_por === usuario.id ? `<button type="button" class="secundario" data-retirar-disputa="${e.id}">Retirar mi disputa</button>` : ""}</section>` : ""}
      ${!esMio && e.disputas?.estado !== "activa" && (Date.now() - new Date(e.creado_en).getTime()) < 48 * 3600 * 1000
        ? `<button type="button" class="secundario" data-disputar="${e.id}" style="margin-top:12px">Disputar la evidencia</button><p class="ayuda">Tienes 48 horas desde que se registró.</p>` : ""}
      ${editable ? `<button type="button" class="secundario" data-borrar-entreno="${e.id}" style="margin-top:20px;color:var(--error)">Eliminar entrenamiento</button>` : ""}`);
  }

  async function recargarEstado() {
    const r = await db.rpc("estado_general");
    if (!r.error) estado = r.data;
  }

  // ---------- Acciones de entrenamientos (vista y hoja)
  async function accionesEntrenos(e) {
    const t = e.target;
    const reg = t.closest("[data-accion]");
    if (reg?.dataset.accion === "registrar") return vistaRegistrar();
    if (reg?.dataset.accion === "volver-entrenar") return irA("entrenar");
    const ver = t.closest("[data-ver]");
    if (ver) { entrenarDe = ver.dataset.ver; return vistaEntrenar(); }
    const item = t.closest("[data-entreno]");
    if (item) return verEntreno(Number(item.dataset.entreno));
    const jb = t.closest("[data-entreno-juntos]");
    if (jb) {
      jb.disabled = true;
      const r = await db.rpc("responder_entreno_juntos", { p_entreno: Number(jb.dataset.id), p_acepta: jb.dataset.entrenoJuntos === "si" });
      if (r.error) { jb.disabled = false; return avisar(errorLegible(r.error)); }
      avisar(r.data === "confirmado" ? "Confirmado: entrenaron juntos. 💞" : "Anotado.", "ok");
      cerrarHoja(); await recargarEstado(); return irA(vistaActual === "registrar" ? "entrenar" : vistaActual);
    }
    const borrar = t.closest("[data-borrar-entreno]");
    if (borrar) {
      if (!confirm("¿Eliminar este entrenamiento? No se puede deshacer.")) return;
      const r = await db.from("entrenos").delete().eq("id", Number(borrar.dataset.borrarEntreno));
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja(); avisar("Entrenamiento eliminado.", "ok"); await recargarEstado(); return irA("entrenar");
    }
    const cal = t.closest("[data-rutina-cal]");
    if (cal) {
      await db.from("rutinas_youtube").update({ calificacion: Number(cal.dataset.rutinaCal) }).eq("id", Number(cal.dataset.id));
      return cargarRutinas();
    }
    const fav = t.closest("[data-rutina-fav]");
    if (fav) {
      await db.from("rutinas_youtube").update({ favorito: fav.dataset.fav !== "true" }).eq("id", Number(fav.dataset.rutinaFav));
      return cargarRutinas();
    }
    const usar = t.closest("[data-rutina-usar]");
    if (usar) return vistaRegistrar(Number(usar.dataset.rutinaUsar));
  }
  $("vista").addEventListener("click", accionesEntrenos);
  $("hoja").addEventListener("click", accionesEntrenos);


  // ================================================================ EXCEPCIONES (fase 4)
  const MOTIVOS = {
    viaje: ["✈️", "Viaje"], enfermedad: ["🤒", "Enfermedad"], lesion: ["🩹", "Lesión"], pausa: ["⏸", "Pausa"],
    navidad: ["🎄", "Navidad"], ano_nuevo: ["🎆", "Año nuevo"], cumpleanos: ["🎂", "Cumpleaños"], cumpleanos_pareja: ["🎂", "Cumpleaños"]
  };
  const TRATAMIENTOS = [["descanso", "😴 Descanso"], ["fisioterapia", "🩺 Fisioterapia"], ["medicamentos", "💊 Medicamentos"],
    ["masajes", "💆 Masajes"], ["frio_calor", "🧊 Frío / calor"], ["otro", "✨ Otro"]];
  const ESTADO_JUST = { pendiente: "Pendiente", aprobada: "Aprobada", vetada: "Vetada", retirada: "Retirada" };

  // Meta de la semana descontando días justificados, libres o en pausa (sin entrenamiento)
  function metaEfectiva(p) {
    const meta = p.meta_mes?.entrenos_semana || 0;
    const excusas = p.excusas || {};
    const hechos = p.dias_entrenados || [];
    const plan = p.plan || [];
    const red = Object.keys(excusas).map(Number).filter((d) => plan.includes(d) && !hechos.includes(d)).length;
    return Math.max(0, meta - red);
  }
  const fechaDeDia = (p, dow) => sumarDias(p.semana_actual, dow - 1);
  const nombreDia = (iso) => fmt(iso, { weekday: "long", day: "numeric", month: "short" });

  // ---------- Tarjeta "Cambios y ausencias" en Entrenar
  function tarjetaCambios() {
    return `
      <section class="tarjeta">
        <h3>Cambios y ausencias</h3>
        <div class="botones-lista">
          <button type="button" class="secundario" data-exc="mover">↔️ Mover un entrenamiento</button>
          <button type="button" class="secundario" data-exc="justificar">📝 Justificar una ausencia</button>
          <button type="button" class="secundario" data-exc="lesion">🩹 Lesión y pausa</button>
          <button type="button" class="enlace" data-exc="historial">Ver mis ausencias y cupos</button>
        </div>
      </section>`;
  }

  // ---------- "Necesita tu respuesta" (Inicio y Entrenar)
  async function cargarPorResponder(cont) {
    if (!cont) return;
    const { data } = await db.rpc("estado_excepciones");
    if (!data) { cont.innerHTML = ""; return; }
    const otro = esc(pareja()?.nombre || "Tu pareja");
    const r = data.por_responder;
    const bloques = [];
    for (const j of r.justificaciones) bloques.push(`
      <section class="tarjeta pendiente">
        <h3>${MOTIVOS[j.tipo][0]} ${otro} justificó el ${nombreDia(j.fecha)}</h3>
        <p><strong>${MOTIVOS[j.tipo][1]}:</strong> ${esc(j.motivo)}</p>
        ${j.foto_ruta ? `<button type="button" class="enlace" data-ver-foto="${esc(j.foto_ruta)}" style="text-align:left;padding-left:0">Ver foto adjunta</button>` : ""}
        <p class="ayuda">Si no respondes en 48 horas, se aprueba sola.</p>
        <div class="acciones-juntos">
          <button type="button" data-just="si" data-id="${j.id}">Aprobar</button>
          <button type="button" class="secundario" style="margin:0" data-just="no" data-id="${j.id}">Vetar</button>
        </div>
      </section>`);
    for (const pa of r.pausas) bloques.push(`
      <section class="tarjeta pendiente">
        <h3>⏸ ${otro} pide pausar la competencia</h3>
        <p>Lesión: ${esc(pa.motivo)}</p>
        <p>Desde el ${nombreDia(pa.desde)}${pa.meta_adaptada ? ` · meta adaptada de ${pa.meta_adaptada} por semana` : " · sin meta adaptada"}.</p>
        <p class="ayuda">Mientras dure, no tendrá faltas ni multas y el marcador quedará congelado. Necesita tu "sí".</p>
        <div class="acciones-juntos">
          <button type="button" data-pausa="si" data-id="${pa.id}">Aprobar pausa</button>
          <button type="button" class="secundario" style="margin:0" data-pausa="no" data-id="${pa.id}">Rechazar</button>
        </div>
      </section>`);
    for (const a of r.ampliaciones) bloques.push(`
      <section class="tarjeta pendiente">
        <h3>✈️ ${otro} pide ${a.dias} día${a.dias === 1 ? "" : "s"} más de viaje</h3>
        <p>${esc(a.motivo)}</p>
        <p class="ayuda">Sin respuesta en 48 horas, se rechaza.</p>
        <div class="acciones-juntos">
          <button type="button" data-ampl="si" data-id="${a.id}">Aceptar</button>
          <button type="button" class="secundario" style="margin:0" data-ampl="no" data-id="${a.id}">Rechazar</button>
        </div>
      </section>`);
    cont.innerHTML = bloques.length ? `<h3 style="margin:22px 0 10px">Necesita tu respuesta</h3>` + bloques.join("") : "";
  }

  // ---------- Hoja: mover un entrenamiento
  function hojaMover() {
    const y = yo();
    const plan = y.plan || [];
    const hoy = y.hoy;
    const destinosPrevios = (y.reprogramaciones || []).map((r) => r.destino);
    const origenes = plan.map((d) => fechaDeDia(y, d)).filter((f) => f >= hoy && !destinosPrevios.includes(f));
    const destinos = [1, 2, 3, 4, 5, 6, 7].filter((d) => !plan.includes(d)).map((d) => fechaDeDia(y, d)).filter((f) => f >= hoy);
    const usadas = (y.reprogramaciones || []).length;
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.6rem">Mover un entrenamiento</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">Dentro de esta semana y antes de que termine el día original. Usaste ${usadas} de 2 esta semana.</p>
      ${!origenes.length || !destinos.length ? `<p class="aviso">No hay ${!origenes.length ? "entrenamientos previstos que puedas mover" : "días libres a los que moverlo"} esta semana.</p>` : `
      <div class="campo"><label for="mv-origen">Entrenamiento previsto del</label>
        <select id="mv-origen">${origenes.map((f) => `<option value="${f}">${nombreDia(f)}</option>`).join("")}</select></div>
      <div class="campo"><label for="mv-destino">Moverlo al</label>
        <select id="mv-destino">${destinos.map((f) => `<option value="${f}">${nombreDia(f)}</option>`).join("")}</select></div>
      <button type="button" class="boton-principal" id="mv-guardar">Mover</button>`}`);
    $("mv-guardar")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      const r = await db.rpc("reprogramar", { p_origen: $("mv-origen").value, p_destino: $("mv-destino").value });
      e.target.disabled = false;
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja(); avisar("Entrenamiento movido.", "ok"); await recargarEstado(); irA("entrenar");
    });
  }

  // ---------- Hoja: justificar una ausencia
  async function hojaJustificar() {
    const { data } = await db.rpc("estado_excepciones");
    const y = yo();
    const c = data?.cupos;
    let tipo = "enfermedad", foto = null;
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.6rem">Justificar una ausencia</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">Hasta 2 días después de la ausencia. ${esc(pareja()?.nombre || "Tu pareja")} tendrá 48 horas para vetarla.</p>
      ${c ? `<div class="cupos"><span>✈️ Viaje: <strong>${c.viaje.total - c.viaje.usados}</strong> de ${c.viaje.total} disponibles</span><span>🤒 Enfermedad: <strong>${c.enfermedad.total - c.enfermedad.usados}</strong> de ${c.enfermedad.total}</span><span>🩹 Lesión: sin tope</span></div>` : ""}
      <span class="grupo-titulo" style="margin-top:16px">Motivo</span>
      <div class="opciones campo" id="js-tipo">
        <label><input type="radio" name="js-tipo" value="viaje"><span>✈️ Viaje</span></label>
        <label><input type="radio" name="js-tipo" value="enfermedad" checked><span>🤒 Enfermedad</span></label>
        <label><input type="radio" name="js-tipo" value="lesion"><span>🩹 Lesión</span></label>
      </div>
      <div class="fila campo">
        <div><label for="js-desde">Desde</label><input id="js-desde" type="date" value="${y.hoy}" min="${sumarDias(y.hoy, -2)}" max="${sumarDias(y.hoy, 60)}"></div>
        <div><label for="js-hasta">Hasta</label><input id="js-hasta" type="date" value="${y.hoy}" min="${sumarDias(y.hoy, -2)}" max="${sumarDias(y.hoy, 60)}"></div>
      </div>
      <p class="ayuda" style="margin:-8px 0 16px">Solo consumen cupo los días con entrenamiento previsto.</p>
      <div class="campo"><label for="js-motivo">Explica qué pasó</label><textarea id="js-motivo" maxlength="500"></textarea></div>
      <div class="campo" id="js-foto-c"><span class="grupo-titulo">Foto (opcional): nota médica, receta…</span>
        <label class="agregar-foto" style="aspect-ratio:auto;padding:16px" id="js-foto-l"><input type="file" accept="image/*" id="js-foto">📷 Adjuntar foto</label></div>
      <button type="button" class="boton-principal" id="js-guardar">Enviar justificación</button>
      <button type="button" class="enlace" data-exc="ampliar">¿Te faltan días de viaje? Pide una ampliación</button>`);
    $("js-tipo").addEventListener("change", (e) => { tipo = e.target.value; });
    $("js-foto").addEventListener("change", (e) => {
      foto = e.target.files[0] || null;
      $("js-foto-l").childNodes[1].textContent = foto ? "✓ Foto lista" : "📷 Adjuntar foto";
    });
    $("js-desde").addEventListener("change", () => { if ($("js-hasta").value < $("js-desde").value) $("js-hasta").value = $("js-desde").value; });
    $("js-guardar").addEventListener("click", async (e) => {
      const motivo = $("js-motivo").value.trim();
      if (!motivo) return avisar("Explica el motivo de la ausencia.");
      e.target.disabled = true;
      let ruta = null;
      try {
        if (foto) {
          ruta = `${usuario.id}/justificaciones/${Date.now()}.jpg`;
          const up = await db.storage.from("evidencias").upload(ruta, await comprimir(foto, 1600, 0.75), { contentType: "image/jpeg" });
          if (up.error) throw up.error;
        }
        const r = await db.rpc("solicitar_justificacion", { p_desde: $("js-desde").value, p_hasta: $("js-hasta").value, p_tipo: tipo, p_motivo: motivo, p_foto: ruta });
        if (r.error) throw r.error;
        cerrarHoja(); avisar(`Justificación enviada (${r.data} día${r.data === 1 ? "" : "s"}).`, "ok");
        await recargarEstado(); irA(vistaActual === "ausencias" ? "ausencias" : "entrenar");
      } catch (err) { e.target.disabled = false; avisar(errorLegible(err)); }
    });
  }

  function hojaAmpliar() {
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.6rem">Más días de viaje</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">Tu pareja tiene que aceptarlo. Sin respuesta en 48 horas, se rechaza.</p>
      <div class="campo"><label for="am-dias">Días extra</label><input id="am-dias" type="number" inputmode="numeric" min="1" max="30" value="1"></div>
      <div class="campo"><label for="am-motivo">Motivo</label><textarea id="am-motivo" maxlength="500"></textarea></div>
      <button type="button" class="boton-principal" id="am-guardar">Pedir ampliación</button>`);
    $("am-guardar").addEventListener("click", async (e) => {
      e.target.disabled = true;
      const r = await db.rpc("ampliar_cupo_viaje", { p_dias: Number($("am-dias").value), p_motivo: $("am-motivo").value });
      e.target.disabled = false;
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja(); avisar("Solicitud enviada.", "ok");
    });
  }

  // ---------- Hoja: lesión y pausa
  async function hojaLesion() {
    const y = yo(), p = pareja();
    const pausa = y.pausa;
    const { data } = await db.rpc("estado_excepciones");
    const tratamientos = data?.tratamientos || [];
    const listaTrat = tratamientos.length ? `<div class="lista">${tratamientos.map((t) => `
        <div class="item" style="grid-template-columns:minmax(0,1fr);min-height:0">
          <span><strong>${TRATAMIENTOS.find((x) => x[0] === t.tipo)?.[1] || t.tipo}</strong><span class="meta">${etiquetaFecha(t.fecha)}${t.notas ? " · " + esc(t.notas) : ""}</span></span>
        </div>`).join("")}</div>` : `<p class="ayuda">Aún no registraste tratamientos.</p>`;
    let cuerpo;
    if (pausa?.estado === "activa") {
      cuerpo = `
        <section class="tarjeta"><h3>⏸ Pausa activa desde el ${nombreDia(pausa.desde)}</h3>
          <p>${esc(pausa.motivo)}</p>
          ${pausa.meta_adaptada ? `<p>Meta adaptada: ${pausa.meta_adaptada} por semana.</p>` : ""}
          ${pausa.revision_solicitada ? `<p class="aviso">${esc(p?.nombre || "Tu pareja")} pidió una revisión${pausa.nota_revision ? ": " + esc(pausa.nota_revision) : ""}.</p>` : ""}
        </section>
        <section class="tarjeta"><h3>¿Cómo va tu lesión hoy?</h3>
          <div class="chips" id="pz-estado" style="margin-top:12px">
            <button type="button" data-pz="igual" aria-pressed="false">Igual</button>
            <button type="button" data-pz="mejorando" aria-pressed="false">Mejorando</button>
            <button type="button" data-pz="lista" aria-pressed="false">Lista para volver</button>
          </div>
          <textarea id="pz-nota" maxlength="500" placeholder="Nota (opcional)" style="margin-top:12px"></textarea>
          <button type="button" class="boton-principal" id="pz-guardar" style="margin-top:12px">Guardar actualización</button>
        </section>`;
    } else if (pausa?.estado === "solicitada") {
      cuerpo = `<section class="tarjeta"><h3>⏸ Pausa solicitada</h3><p>Esperando que ${esc(p?.nombre || "tu pareja")} la apruebe.</p></section>`;
    } else {
      cuerpo = `
        <section class="tarjeta"><h3>¿Una lesión que no se resolverá pronto?</h3>
          <p>El primer día, justifícalo como <strong>Lesión</strong> (sin tope de días). Desde el segundo día puedes pedir una pausa de competencia: no tendrás faltas ni multas, tus rachas se congelan y el marcador se detiene. Tu pareja tiene que aprobarla.</p>
          <div class="fila campo" style="margin-top:16px">
            <div><label for="pz-desde">Pausa desde</label><input id="pz-desde" type="date" value="${y.hoy}" min="${sumarDias(y.hoy, -2)}" max="${sumarDias(y.hoy, 1)}"></div>
            <div><label for="pz-meta">Meta adaptada / semana</label><input id="pz-meta" type="number" inputmode="numeric" min="0" max="7" value="0"></div>
          </div>
          <p class="ayuda" style="margin:-8px 0 14px">Por ejemplo, sesiones de rehabilitación. Déjala en 0 si no puedes entrenar.</p>
          <div class="campo"><label for="pz-motivo">Describe la lesión</label><textarea id="pz-motivo" maxlength="500"></textarea></div>
          <button type="button" class="boton-principal" id="pz-pedir">Pedir pausa</button>
        </section>`;
    }
    const pausaPareja = p?.pausa?.estado === "activa" ? `
      <section class="tarjeta"><h3>⏸ ${esc(p.nombre)} está en pausa</h3>
        <p>${esc(p.pausa.motivo)}</p>
        <textarea id="rv-nota" maxlength="500" placeholder="¿Qué quieres que revise? (opcional)" style="margin-top:12px"></textarea>
        <button type="button" class="secundario" id="rv-pedir">Pedir una revisión de la pausa</button>
      </section>` : "";
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.6rem">Lesión y pausa</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      ${cuerpo}
      ${pausaPareja}
      <section class="tarjeta"><h3>Tratamiento</h3>
        <div class="chips" id="tr-tipo" style="margin:12px 0">${TRATAMIENTOS.map(([k, n]) => `<button type="button" data-tr="${k}" aria-pressed="false">${n}</button>`).join("")}</div>
        <textarea id="tr-notas" maxlength="500" placeholder="Detalles: ejercicios, dosis, sesión…"></textarea>
        <button type="button" class="secundario" id="tr-guardar">Registrar tratamiento de hoy</button>
        <div style="margin-top:14px">${listaTrat}</div>
      </section>`);

    let estadoPz = null, tipoTr = null;
    $("pz-estado")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pz]"); if (!b) return;
      estadoPz = b.dataset.pz; $("pz-estado").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    });
    $("pz-guardar")?.addEventListener("click", async (e) => {
      if (!estadoPz) return avisar("Elige cómo va tu lesión.");
      e.target.disabled = true;
      const r = await db.rpc("actualizar_pausa", { p_estado: estadoPz, p_nota: $("pz-nota").value });
      e.target.disabled = false;
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja(); avisar(r.data === "terminada" ? "¡Bienvenida de vuelta! La pausa terminó hoy." : "Actualización guardada.", "ok");
      await recargarEstado(); irA(vistaActual);
    });
    $("pz-pedir")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      const r = await db.rpc("solicitar_pausa", { p_desde: $("pz-desde").value, p_meta_adaptada: Number($("pz-meta").value || 0), p_motivo: $("pz-motivo").value });
      e.target.disabled = false;
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja(); avisar("Pausa solicitada. Falta que tu pareja la apruebe.", "ok"); await recargarEstado(); irA(vistaActual);
    });
    $("rv-pedir")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      const r = await db.rpc("pedir_revision_pausa", { p_nota: $("rv-nota").value });
      e.target.disabled = false;
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja(); avisar("Revisión pedida.", "ok");
    });
    $("tr-tipo").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tr]"); if (!b) return;
      tipoTr = b.dataset.tr; $("tr-tipo").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    });
    $("tr-guardar").addEventListener("click", async (e) => {
      if (!tipoTr) return avisar("Elige el tipo de tratamiento.");
      e.target.disabled = true;
      const r = await db.from("tratamientos").insert({ user_id: usuario.id, fecha: y.hoy, tipo: tipoTr, notas: $("tr-notas").value.trim() || null });
      e.target.disabled = false;
      if (r.error) return avisar(errorLegible(r.error));
      avisar("Tratamiento registrado.", "ok"); hojaLesion();
    });
  }

  // ---------- Vista: mis ausencias y cupos
  async function vistaAusencias() {
    vistaActual = "ausencias";
    $("vista").innerHTML = `<div class="cabecera-vista"><h2 class="titulo">Ausencias</h2><button type="button" data-accion="volver-entrenar">Volver</button></div><p class="sub">Cargando…</p>`;
    const { data, error } = await db.rpc("estado_excepciones");
    if (error) return avisar(errorLegible(error));
    const c = data.cupos;
    const trim = fmt(data.trimestre, { month: "long" }) + " – " + fmt(sumarMeses(data.trimestre, 2), { month: "long", year: "numeric" });
    $("vista").innerHTML = `
      <div class="cabecera-vista"><h2 class="titulo">Ausencias</h2><button type="button" data-accion="volver-entrenar">Volver</button></div>
      <p class="sub">Trimestre ${trim}</p>
      <section class="tarjeta">
        <h3>Cupos del trimestre</h3>
        <div class="fila-stat"><span>✈️ Viaje</span><strong>${c.viaje.usados} usados</strong><strong>${c.viaje.total - c.viaje.usados} libres</strong></div>
        <div class="fila-stat"><span>🤒 Enfermedad</span><strong>${c.enfermedad.usados} usados</strong><strong>${c.enfermedad.total - c.enfermedad.usados} libres</strong></div>
        <div class="fila-stat"><span>🩹 Lesión</span><strong colspan="2">Sin tope</strong><strong></strong></div>
        ${data.ampliaciones_mias.map((a) => `<p class="ayuda">Ampliación de ${a.dias} día(s): ${a.estado}.</p>`).join("")}
        <button type="button" class="secundario" data-exc="justificar">📝 Justificar una ausencia</button>
      </section>
      <h3 style="margin:22px 0 10px">Mis justificaciones</h3>
      <div class="lista">${data.mias.length ? data.mias.map((j) => `
        <div class="tarjeta" style="margin:0">
          <h3>${MOTIVOS[j.tipo][0]} ${nombreDia(j.fecha)}</h3>
          <span class="etiqueta ${j.estado === "vetada" ? "etiqueta-aviso" : ""}">${ESTADO_JUST[j.estado]}</span>${j.consume_cupo && ["pendiente", "aprobada"].includes(j.estado) ? `<span class="etiqueta">Consume cupo</span>` : ""}
          <p>${esc(j.motivo)}</p>
          ${j.estado === "vetada" && j.nota_veto ? `<p class="aviso">Vetada: ${esc(j.nota_veto)}</p>` : ""}
          ${["pendiente", "aprobada"].includes(j.estado) ? `<button type="button" class="enlace" data-retirar-just="${j.id}" style="text-align:left;padding-left:0">Retirar justificación</button>` : ""}
        </div>`).join("") : `<p class="vacio">No has justificado ausencias.</p>`}</div>`;
  }

  // ---------- Acciones
  async function accionesExcepciones(e) {
    const t = e.target;
    const exc = t.closest("[data-exc]");
    if (exc) {
      const a = exc.dataset.exc;
      if (a === "mover") return hojaMover();
      if (a === "justificar") return hojaJustificar();
      if (a === "lesion") return hojaLesion();
      if (a === "ampliar") return hojaAmpliar();
      if (a === "historial") { cerrarHoja(); return vistaAusencias(); }
    }
    const just = t.closest("[data-just]");
    if (just) {
      const acepta = just.dataset.just === "si";
      let nota = null;
      if (!acepta) {
        nota = prompt("¿Por qué vetas esta justificación? Tu pareja verá esta nota.");
        if (nota === null) return;
        if (!nota.trim()) return avisar("Para vetar hay que escribir una nota.");
      }
      just.disabled = true;
      const r = await db.rpc("responder_justificacion", { p_id: Number(just.dataset.id), p_acepta: acepta, p_nota: nota });
      if (r.error) { just.disabled = false; return avisar(errorLegible(r.error)); }
      avisar(acepta ? "Justificación aprobada." : "Justificación vetada: ese día cuenta como falta.", "ok");
      await recargarEstado(); return irA(vistaActual);
    }
    const pz = t.closest("[data-pausa]");
    if (pz) {
      const acepta = pz.dataset.pausa === "si";
      const nota = acepta ? null : prompt("¿Quieres dejar una nota? (opcional)") || null;
      pz.disabled = true;
      const r = await db.rpc("responder_pausa", { p_id: Number(pz.dataset.id), p_acepta: acepta, p_nota: nota });
      if (r.error) { pz.disabled = false; return avisar(errorLegible(r.error)); }
      avisar(acepta ? "Pausa aprobada. El marcador queda congelado." : "Pausa rechazada.", "ok");
      await recargarEstado(); return irA(vistaActual);
    }
    const am = t.closest("[data-ampl]");
    if (am) {
      am.disabled = true;
      const r = await db.rpc("responder_ampliacion", { p_id: Number(am.dataset.id), p_acepta: am.dataset.ampl === "si" });
      if (r.error) { am.disabled = false; return avisar(errorLegible(r.error)); }
      avisar(r.data === "aprobada" ? "Ampliación aceptada." : "Ampliación rechazada.", "ok");
      return irA(vistaActual);
    }
    const ret = t.closest("[data-retirar-just]");
    if (ret) {
      if (!confirm("¿Retirar esta justificación? Si era un día previsto sin entrenar, contará como falta.")) return;
      const r = await db.rpc("retirar_justificacion", { p_id: Number(ret.dataset.retirarJust) });
      if (r.error) return avisar(errorLegible(r.error));
      avisar("Justificación retirada.", "ok"); await recargarEstado(); return vistaAusencias();
    }
    const foto = t.closest("[data-ver-foto]");
    if (foto) {
      const u = await urlsFirmadas([foto.dataset.verFoto]);
      if (u[foto.dataset.verFoto]) abrirHoja(`<div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.4rem">Foto adjunta</h2><button type="button" data-cerrar-hoja>Cerrar</button></div><div class="galeria"><img src="${u[foto.dataset.verFoto]}" alt="Foto adjunta"></div>`);
    }
    const disp = t.closest("[data-disputar]");
    if (disp) {
      const nota = prompt("¿Por qué disputas esta evidencia? Tu pareja verá esta nota. El entrenamiento dejará de contar.");
      if (nota === null) return;
      const r = await db.rpc("disputar_entreno", { p_entreno: Number(disp.dataset.disputar), p_nota: nota });
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja(); avisar("Evidencia disputada.", "ok"); await recargarEstado(); return irA(vistaActual);
    }
    const rdisp = t.closest("[data-retirar-disputa]");
    if (rdisp) {
      const r = await db.rpc("retirar_disputa", { p_entreno: Number(rdisp.dataset.retirarDisputa) });
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja(); avisar("Disputa retirada: el entrenamiento vuelve a contar.", "ok"); await recargarEstado(); return irA(vistaActual);
    }
  }
  $("vista").addEventListener("click", accionesExcepciones);
  $("hoja").addEventListener("click", accionesExcepciones);

  // ================================================================ MULTAS Y PAGOS (fase 5)
  const usd = (n) => "USD " + Number(n || 0).toFixed(2);
  const ESTADO_MULTA = { pendiente: "Pendiente", pagada: "Pagada" };
  let multasDe = "yo";

  function textoVencimiento(m, hoy) {
    if (m.estado !== "pendiente") return "";
    const dias = (aFecha(m.vence) - aFecha(hoy)) / 86400000;
    if (dias > 0) return `Vence el ${fmt(m.vence, { weekday: "long", day: "numeric", month: "short" })}`;
    if (dias === 0) return "Vence hoy";
    const retraso = -dias;
    return `Vencida hace ${retraso} día${retraso === 1 ? "" : "s"}: ${m.puntos_retraso} pts${Number(m.recargo) > 0 ? ` y ${usd(m.recargo)} de recargo` : ""}`;
  }

  async function vistaMultas() {
    $("vista").innerHTML = `<h2 class="titulo">Multas</h2><p class="sub">Cargando…</p>`;
    const { data, error } = await db.rpc("estado_multas");
    if (error || !data) return avisar("No se pudieron cargar las multas: " + errorLegible(error) + ". ¿Ejecutaste fase5.sql?");
    if (vistaActual !== "multas") return;
    const [mi, otro] = data.participantes;
    const pYo = yo(), pOtro = pareja();
    const nom = (p) => esc(p?.nombre || "—");
    const tema = (p) => p?.tema || "";
    const vencidas = mi.multas.filter((m) => m.estado === "pendiente" && m.vence < mi.hoy).length;
    const proximoVence = mi.multas.filter((m) => m.estado === "pendiente").map((m) => m.vence).sort()[0];
    const verDe = multasDe === "yo" ? mi : otro;
    const comprobantes = (otro?.pagos || []).filter((p) => p.disponible && p.ruta);

    $("vista").innerHTML = `
      <h2 class="titulo">Multas</h2>
      <p class="sub">Cada falta injustificada genera una multa. Transfiere a tu cuenta de ahorro del desafío y sube el comprobante.</p>

      <section class="tarjeta deuda ${Number(mi.pendiente) > 0 ? "con-deuda" : ""}">
        <span class="puntos-etiqueta">Tu deuda pendiente</span>
        <div class="cifra">${usd(mi.pendiente)}</div>
        ${Number(mi.pendiente) > 0 ? `
          <p>${vencidas ? `⚠️ Tienes ${vencidas} multa${vencidas === 1 ? "" : "s"} vencida${vencidas === 1 ? "" : "s"}: cada día resta puntos y, desde el día 5, suma recargo.` : `Plazo: ${fmt(proximoVence, { weekday: "long", day: "numeric", month: "short" })}.`}</p>
          <button type="button" class="boton-principal" data-pagar style="margin-top:14px">Ya transferí: subir comprobante</button>` : `<p>Estás al día. 🎉</p>`}
        <p class="ayuda" style="margin-top:12px">Tu próxima falta costaría ${usd(mi.proxima.monto)} (falta n.º ${mi.proxima.nivel} desde el último reinicio). Un mes perfecto reinicia la escala.</p>
      </section>

      ${comprobantes.map((p) => `
        <section class="tarjeta pendiente">
          <h3>🧾 ${nom(pOtro)} subió un comprobante de ${usd(p.monto)}</h3>
          <p>Solo puedes verlo una vez; después se borra.</p>
          <button type="button" class="secundario" data-ver-comprobante="${p.id}" data-ruta="${esc(p.ruta)}">Ver comprobante</button>
        </section>`).join("")}

      <section class="tarjeta">
        <div class="fila-stat cabecera"><span></span><strong class="${tema(pYo)}">${nom(pYo)}</strong>${otro ? `<strong class="${tema(pOtro)}">${nom(pOtro)}</strong>` : ""}</div>
        <div class="fila-stat"><span>Deuda generada</span><strong class="${tema(pYo)}">${usd(mi.generada)}</strong>${otro ? `<strong class="${tema(pOtro)}">${usd(otro.generada)}</strong>` : ""}</div>
        <div class="fila-stat"><span>Deuda pendiente</span><strong class="${tema(pYo)}">${usd(mi.pendiente)}</strong>${otro ? `<strong class="${tema(pOtro)}">${usd(otro.pendiente)}</strong>` : ""}</div>
        <div class="fila-stat"><span>Saldo transferido</span><strong class="${tema(pYo)}">${usd(mi.transferido)}</strong>${otro ? `<strong class="${tema(pOtro)}">${usd(otro.transferido)}</strong>` : ""}</div>
      </section>

      <div class="segmentado" role="group" aria-label="Ver multas de">
        <button type="button" data-multas-de="yo" aria-pressed="${multasDe === "yo"}">Mis multas</button>
        <button type="button" data-multas-de="otro" aria-pressed="${multasDe === "otro"}">${nom(pOtro)}</button>
      </div>
      <div class="lista">
        ${verDe?.multas.length ? verDe.multas.map((m) => `
          <div class="item" style="grid-template-columns:minmax(0,1fr) auto;min-height:0">
            <span><strong>Falta n.º ${m.nivel} · semana del ${fechaCorta(m.semana)}</strong>
              <span class="meta">${ESTADO_MULTA[m.estado]}${m.estado === "pendiente" ? " · " + textoVencimiento(m, verDe.hoy) : ""}</span></span>
            <span class="monto ${m.estado === "pendiente" ? "rojo" : ""}">${usd(Number(m.monto_base) + Number(m.recargo))}</span>
          </div>`).join("") : `<p class="vacio">Sin multas. 💪</p>`}
      </div>
      ${verDe?.pagos.length ? `<h3 style="margin:22px 0 10px">Pagos</h3><div class="lista">${verDe.pagos.map((p) => `
          <div class="item" style="grid-template-columns:minmax(0,1fr) auto;min-height:0">
            <span><strong>${fmt(p.fecha, { day: "numeric", month: "long" })}</strong>
              <span class="meta">${p.visto ? "Comprobante visto y borrado" : p.borrado || !p.disponible ? "Comprobante borrado" : "Comprobante sin ver"}</span></span>
            <span class="monto">${usd(p.monto)}</span>
          </div>`).join("")}</div>` : ""}`;
  }

  // ---------- Subir comprobante
  function hojaPagar() {
    let foto = null;
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.6rem">Subir comprobante</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">El comprobante paga <strong>todas</strong> tus multas pendientes. Antes, transfiere el total a tu cuenta de ahorro del desafío. Marcar el pago aquí no mueve dinero.</p>
      <div id="pg-foto" class="campo"><label class="agregar-foto" style="aspect-ratio:auto;padding:28px"><input type="file" accept="image/*" id="pg-archivo">📷 Elegir captura de la transferencia</label></div>
      <p class="ayuda">Tu pareja podrá verlo una sola vez; después se borra. Guarda tu propio respaldo en tu banco.</p>
      <button type="button" class="boton-principal" id="pg-enviar" disabled>Registrar pago</button>`);
    $("pg-archivo").addEventListener("change", (e) => {
      foto = e.target.files[0] || null;
      if (!foto) return;
      $("pg-foto").innerHTML = `<div class="galeria"><img src="${URL.createObjectURL(foto)}" alt="Vista previa del comprobante"></div>`;
      $("pg-enviar").disabled = false;
    });
    $("pg-enviar").addEventListener("click", async (e) => {
      if (!foto) return avisar("Elige la captura del comprobante.");
      e.target.disabled = true; e.target.textContent = "Subiendo…";
      try {
        const ruta = `${usuario.id}/${Date.now()}.jpg`;
        const up = await db.storage.from("comprobantes").upload(ruta, await comprimir(foto, 1800, 0.82), { contentType: "image/jpeg" });
        if (up.error) throw up.error;
        const r = await db.rpc("registrar_pago", { p_ruta: ruta });
        if (r.error) throw r.error;
        cerrarHoja(); avisar(`Pago de ${usd(r.data)} registrado. ¡Al día! 🎉`, "ok"); vistaMultas();
      } catch (err) { e.target.disabled = false; e.target.textContent = "Registrar pago"; avisar(errorLegible(err)); }
    });
  }

  // ---------- Ver comprobante (una sola vez)
  async function verComprobante(pagoId, ruta) {
    if (!confirm("Solo puedes ver este comprobante una vez. ¿Abrirlo ahora?")) return;
    const { data, error } = await db.storage.from("comprobantes").createSignedUrl(ruta, 120);
    if (error || !data?.signedUrl) return avisar("Ese comprobante ya no está disponible.");
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.4rem">Comprobante</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub" id="cp-estado">Cargando…</p>
      <div class="galeria"><img id="cp-img" src="${data.signedUrl}" alt="Comprobante de transferencia"></div>`);
    let marcado = false;
    $("cp-img").addEventListener("load", () => {
      $("cp-estado").textContent = "Míralo con calma: al cerrar, se borrará.";
      setTimeout(async () => {
        if ($("hoja").hidden || marcado) return;
        marcado = true;
        const r = await db.rpc("marcar_comprobante_visto", { p_pago: pagoId });
        if (r.error) return;
        const del = await db.storage.from("comprobantes").remove([ruta]);
        if (!del.error) await db.rpc("marcar_comprobante_borrado", { p_pago: pagoId });
      }, 3000);
    });
    $("cp-img").addEventListener("error", () => { $("cp-estado").textContent = "No se pudo cargar. Inténtalo de nuevo más tarde."; });
  }

  // Limpieza: borra del almacenamiento mis comprobantes que caducaron sin verse
  async function limpiarComprobantes() {
    const { data } = await db.from("pagos").select("id, comprobante_ruta, creado_en, visto_en, comprobante_borrado")
      .eq("user_id", usuario.id).eq("comprobante_borrado", false);
    for (const p of data || []) {
      const caducado = Date.now() - new Date(p.creado_en).getTime() > 7 * 86400000;
      if (!p.visto_en && !caducado) continue;
      const del = await db.storage.from("comprobantes").remove([p.comprobante_ruta]);
      if (!del.error) await db.rpc("marcar_comprobante_borrado", { p_pago: p.id });
    }
  }

  async function accionesMultas(e) {
    const t = e.target;
    if (t.closest("[data-pagar]")) return hojaPagar();
    const de = t.closest("[data-multas-de]");
    if (de) { multasDe = de.dataset.multasDe; return vistaMultas(); }
    const vc = t.closest("[data-ver-comprobante]");
    if (vc) return verComprobante(Number(vc.dataset.verComprobante), vc.dataset.ruta);
    if (t.closest("[data-ir-multas]")) return irA("multas");
  }
  $("vista").addEventListener("click", accionesMultas);
  $("hoja").addEventListener("click", (e) => {
    if (e.target.closest("[data-cerrar-hoja]") && vistaActual === "multas") vistaMultas();
  });

  // ================================================================ NOTIFICACIONES Y MENSAJES (fase 6)
  const TIPOS_AVISO = [
    ["mensajes", "💬 Mensajes de tu pareja"], ["solicitudes", "📝 Justificaciones, vetos, pausas y disputas"],
    ["animo", "💗 Ánimo de tu pareja después de entrenar"], ["juntos", "💞 Confirmaciones de \"juntos\""],
    ["entreno_previsto", "🏋️‍♀️ Entrenamiento previsto (8:00)"], ["meta_pendiente", "⏳ Meta pendiente (domingo 17:00)"],
    ["multas", "💰 Multas y pagos"], ["sueno", "😴 Recordatorios de sueño"], ["lesion", "🩹 Seguimiento de lesiones"],
    ["bienestar", "💛 Bienestar: check-in y hábitos de cuidado"], ["logros", "✨ Logros y rachas"], ["ciclo", "🌸 Inicio del periodo de tu pareja"], ["peso", "⚖️ Recordatorio semanal de peso"], ["resumen", "📊 Resumen semanal (lunes)"], ["zona", "🛬 Cambios de zona horaria"]
  ];
  const instalada = () => window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  const aUint8 = (b64) => {
    const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  };

  async function estadoPush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "no_soportado";
    if (!instalada()) return "no_instalada";
    if (Notification.permission === "denied") return "bloqueadas";
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub && Notification.permission === "granted" ? "activas" : "inactivas";
  }

  async function activarPush(boton) {
    try {
      boton.disabled = true;
      const permiso = await Notification.requestPermission();
      if (permiso !== "granted") throw new Error("No diste permiso para las notificaciones.");
      const { data: clave, error } = await db.rpc("clave_vapid");
      if (error || !clave) throw new Error("Falta la clave pública de notificaciones en Supabase (paso 3 de las instrucciones).");
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: aUint8(clave) }));
      const j = sub.toJSON();
      const r = await db.from("suscripciones_push").upsert(
        { user_id: usuario.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: "endpoint" });
      if (r.error) throw r.error;
      avisar("Notificaciones activadas en este iPhone. 🔔", "ok");
    } catch (err) {
      avisar(errorLegible(err));
    } finally {
      boton.disabled = false;
      pintarAvisos();
    }
  }

  async function desactivarPush() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await db.from("suscripciones_push").delete().eq("endpoint", sub.endpoint);
      await sub.unsubscribe();
    }
    avisar("Notificaciones desactivadas en este iPhone.", "ok");
    pintarAvisos();
  }

  // Tarjeta de notificaciones dentro de Perfil
  async function pintarAvisos() {
    const cont = $("avisos");
    if (!cont) return;
    const est = await estadoPush();
    const { data: prefs } = await db.from("preferencias_notificacion").select("tipo, activo").eq("user_id", usuario.id);
    const off = new Set((prefs || []).filter((p) => !p.activo).map((p) => p.tipo));
    const textos = {
      no_soportado: "Este navegador no admite notificaciones.",
      no_instalada: "Para recibir notificaciones, abre training.us desde el icono de tu pantalla de inicio.",
      bloqueadas: "Las bloqueaste. Actívalas en Ajustes del iPhone → Notificaciones → training.us.",
      inactivas: "Todavía no están activadas en este iPhone.",
      activas: "Activadas en este iPhone. 🔔"
    };
    cont.innerHTML = `
      <h3>Notificaciones</h3>
      <p>${textos[est]}</p>
      ${est === "inactivas" ? `<button type="button" class="boton-principal" data-push="activar" style="margin-top:14px">Activar notificaciones</button>` : ""}
      ${est === "activas" ? `<div class="acciones-juntos"><button type="button" class="secundario" style="margin:0" data-push="probar">Enviar una prueba</button>
        <button type="button" class="secundario" style="margin:0" data-push="desactivar">Desactivar</button></div>` : ""}
      <span class="grupo-titulo" style="margin-top:20px">Qué avisos quieres recibir</span>
      <div class="lista-interruptores">
        ${TIPOS_AVISO.map(([k, n]) => `<label class="interruptor"><span>${n}</span><input type="checkbox" data-pref="${k}" ${off.has(k) ? "" : "checked"}></label>`).join("")}
      </div>`;
  }

  async function accionesAvisos(e) {
    const b = e.target.closest("[data-push]");
    if (b) {
      if (b.dataset.push === "activar") return activarPush(b);
      if (b.dataset.push === "desactivar") return desactivarPush();
      if (b.dataset.push === "probar") {
        const r = await db.rpc("probar_notificacion");
        if (r.error) return avisar(errorLegible(r.error));
        return avisar("Prueba enviada: llegará en menos de un minuto.", "ok");
      }
    }
  }
  async function cambioPreferencia(e) {
    const c = e.target.closest("[data-pref]");
    if (!c) return;
    const r = await db.from("preferencias_notificacion").upsert({ user_id: usuario.id, tipo: c.dataset.pref, activo: c.checked }, { onConflict: "user_id,tipo" });
    if (r.error) { c.checked = !c.checked; avisar(errorLegible(r.error)); }
  }
  $("vista").addEventListener("click", accionesAvisos);
  $("vista").addEventListener("change", cambioPreferencia);

  // ---------- Mensajes
  let canalMensajes = null;
  const RAPIDOS = ["¡Bien hecho! 💪", "Tú puedes 💗", "Estoy orgullosa/o de ti ✨", "Vamos juntos 🏃", "Te quiero 💞", "Descansa bien 😴"];

  async function tarjetaMensajes(cont) {
    if (!cont) return;
    const { data } = await db.rpc("resumen_mensajes");
    const u = data?.ultimo;
    const quien = u ? (u.sistema ? "training.us" : u.de === usuario.id ? "Tú" : esc(pareja()?.nombre || "")) : "";
    cont.innerHTML = `
      <button type="button" class="item" data-ir-mensajes style="margin-bottom:14px">
        <span class="mini">💬</span>
        <span><strong>Mensajes${data?.sin_leer ? ` <span class="burbuja-num">${data.sin_leer}</span>` : ""}</strong>
          <span class="meta">${u ? `${quien}: ${esc(u.texto.slice(0, 70))}` : "Envíale ánimo a tu pareja"}</span></span>
        <span class="lado">›</span>
      </button>`;
  }

  async function vistaMensajes() {
    vistaActual = "mensajes";
    const otro = pareja();
    $("vista").innerHTML = `
      <div class="cabecera-vista"><h2 class="titulo">Mensajes</h2><button type="button" data-accion="volver-inicio">Volver</button></div>
      <div id="chat" class="chat"><p class="vacio">Cargando…</p></div>
      <div class="chips rapidos">${RAPIDOS.map((t) => `<button type="button" data-rapido="${esc(t)}">${t}</button>`).join("")}</div>
      <div class="escribir">
        <textarea id="msg-texto" maxlength="1000" rows="1" placeholder="Escríbele a ${esc(otro?.nombre || "tu pareja")}…"></textarea>
        <button type="button" id="msg-enviar" aria-label="Enviar">➤</button>
      </div>`;
    await cargarChat();
    db.rpc("marcar_leidos");
    if (!canalMensajes) {
      canalMensajes = db.channel("mensajes-" + usuario.id)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "mensajes" }, () => {
          if (vistaActual === "mensajes") { cargarChat(); db.rpc("marcar_leidos"); }
        })
        .subscribe();
    }
    $("msg-enviar").addEventListener("click", () => enviarMensaje($("msg-texto").value));
  }

  async function cargarChat() {
    const { data, error } = await db.from("mensajes").select("*").order("creado_en", { ascending: false }).limit(80);
    if (error) return avisar(errorLegible(error));
    const chat = $("chat");
    if (!chat) return;
    const temaYo = yo()?.tema || "rosa", temaOtro = pareja()?.tema || "azul";
    const lista = [...data].reverse();
    chat.innerHTML = lista.length ? lista.map((m) => {
      const hora = new Date(m.creado_en).toLocaleString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      if (m.sistema) return `<div class="msg sistema"><span>${esc(m.texto)}</span><small>${hora}</small></div>`;
      const mio = m.de === usuario.id;
      return `<div class="msg ${mio ? "mio " + temaYo : "suyo " + temaOtro}"><span>${esc(m.texto)}</span><small>${hora}${mio && m.leido_en ? " · Leído" : ""}</small></div>`;
    }).join("") : `<p class="vacio">Todavía no hay mensajes. ¡Escríbele algo bonito!</p>`;
    window.scrollTo(0, document.body.scrollHeight);
  }

  async function enviarMensaje(texto) {
    texto = (texto || "").trim();
    if (!texto) return;
    const r = await db.from("mensajes").insert({ de: usuario.id, para: pareja()?.id, texto });
    if (r.error) return avisar(errorLegible(r.error));
    if ($("msg-texto")) $("msg-texto").value = "";
    cargarChat();
  }

  $("vista").addEventListener("click", (e) => {
    if (e.target.closest("[data-ir-mensajes]")) return vistaMensajes();
    if (e.target.closest('[data-accion="volver-inicio"]')) return irA("inicio");
    const rap = e.target.closest("[data-rapido]");
    if (rap) return enviarMensaje(rap.dataset.rapido);
  });

  // Abrir la sección indicada por una notificación (#mensajes, #multas…)
  function abrirDesdeUrl(url) {
    const destino = (String(url || "").split("#")[1] || "").trim();
    if (!destino || !estado || !perfil?.completado) return;
    if (destino === "mensajes") return vistaMensajes();
    if (["inicio", "entrenar", "comida", "metas", "multas", "perfil", "ausencias", "recompensas", "mas", "habitos", "checkin"].includes(destino)) irA(destino);
  }
  navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.tipo === "abrir") abrirDesdeUrl(e.data.url); });

  // ================================================================ RETOS Y RECOMPENSAS (fase 7)
  const TIPO_RETO = { entrenamiento: ["🏋️", "Día extra"], entreno_especifico: ["🧭", "Entreno nuevo"], habito: ["🥗", "Hábito"], marca: ["🏆", "Marca"] };
  const ESTADO_RETO = { propuesto: "Esperando respuesta", aceptado: "En curso", rechazado: "Rechazado", cumplido: "Cumplido ✓", no_cumplido: "No cumplido", esfuerzo: "🌟 Cumplido por esfuerzo" };
  const EJEMPLO_RETO = { entrenamiento: "Un entrenamiento extra esta semana", entreno_especifico: "Probar un entrenamiento distinto esta semana", habito: "Cero azúcar añadido toda la semana", marca: "Levantar 60 kg en sentadilla" };
  const dentroDe48h = (iso) => iso && Date.now() - new Date(iso).getTime() < 48 * 3600 * 1000;

  function tarjetaReto(r, cuerpo = "") {
    const [e, n] = TIPO_RETO[r.tipo];
    return `
      <div class="reto">
        <span class="etiqueta">${e} ${n}</span><span class="etiqueta ${["no_cumplido", "rechazado"].includes(r.estado) ? "etiqueta-aviso" : ""}">${ESTADO_RETO[r.estado]}</span>
        <p class="reto-texto">${esc(r.descripcion)}${r.objetivo ? ` <small>· Meta: ${esc(r.objetivo)}</small>` : ""}</p>
        ${r.tipo === "entreno_especifico" ? `<p class="ayuda">${TIPO[r.entreno_tipo]?.emoji || ""} ${TIPO[r.entreno_tipo]?.nombre || ""}${r.entreno_zona ? " · " + ZONA_NOMBRE[r.entreno_zona] : ""}${r.logrado ? " · ✓ Ya lo hizo esta semana" : ""}</p>` : ""}
        ${r.nota_declaracion ? `<p class="ayuda">Nota: ${esc(r.nota_declaracion)}</p>` : ""}
        ${r.disputa_nota ? `<p class="aviso">Disputado: ${esc(r.disputa_nota)}</p>` : ""}
        ${cuerpo}
      </div>`;
  }

  async function seccionRetos(cont) {
    if (!cont) return;
    const { data: d, error } = await db.rpc("estado_retos");
    if (error || !d) { cont.innerHTML = `<p class="ayuda">No se pudieron cargar los retos. ¿Ejecutaste fase7.sql?</p>`; return; }
    const otro = esc(pareja()?.nombre || "tu pareja");
    const yoId = usuario.id;
    const ahoraYo = d.ahora_yo.slice(0, 16);
    const mios = d.retos.filter((r) => r.retado === yoId);
    const suyos = d.retos.filter((r) => r.proponente === yoId);
    const propuestoAMi = mios.find((r) => r.estado === "propuesto");
    const enCurso = mios.filter((r) => ["aceptado"].includes(r.estado) && r.semana <= d.semana_yo);
    const miPropuesta = suyos.find((r) => r.semana > d.semana_otro);
    const suyoActivo = suyos.filter((r) => r.semana <= d.semana_otro && r.semana >= sumarDias(d.semana_otro, -7));
    const bloques = [];

    if (propuestoAMi) bloques.push(`<span class="grupo-titulo">${otro} te reta (semana del ${fechaCorta(propuestoAMi.semana)})</span>` +
      tarjetaReto(propuestoAMi, `<p class="ayuda">Si lo aceptas, se suma a tu meta de esa semana. Rechazarlo no cuesta puntos.</p>
        <div class="acciones-juntos"><button type="button" data-reto-resp="si" data-id="${propuestoAMi.id}">Aceptar</button>
        <button type="button" class="secundario" style="margin:0" data-reto-resp="no" data-id="${propuestoAMi.id}">Rechazar</button></div>`));

    for (const r of enCurso) {
      const domingo = sumarDias(r.semana, 6);
      const puedeDeclarar = ["habito", "marca"].includes(r.tipo) && ahoraYo >= domingo && ahoraYo < sumarDias(r.semana, 7) + "T12:00";
      bloques.push(`<span class="grupo-titulo">Tu reto de la semana del ${fechaCorta(r.semana)}</span>` + tarjetaReto(r,
        r.tipo === "entrenamiento" ? `<p class="ayuda">Tu meta de esa semana subió en 1; se evalúa sola al cerrar la semana.</p>` :
        r.tipo === "entreno_especifico" ? `<p class="ayuda">${r.logrado ? "¡Listo! Ya registraste ese entrenamiento. 🎉" : "Se cumple solo al registrar un entrenamiento válido de ese tipo esta semana."} No sube tu meta y no resta si no lo haces.</p>` :
        puedeDeclarar ? `<div class="acciones-juntos"><button type="button" data-reto-declarar="si" data-id="${r.id}" data-tipo="${r.tipo}">Lo cumplí</button>
          <button type="button" class="secundario" style="margin:0" data-reto-declarar="no" data-id="${r.id}" data-tipo="${r.tipo}">No lo cumplí</button></div>
          <p class="ayuda">Plazo: lunes a las 12:00.</p>` :
        `<p class="ayuda">Podrás declararlo desde el domingo ${fechaCorta(domingo)} hasta el lunes a las 12:00.</p>`));
    }

    for (const r of suyoActivo) {
      let acciones = "";
      if (["habito", "marca"].includes(r.tipo) && r.estado === "cumplido" && dentroDe48h(r.resuelto_en))
        acciones = `${r.evidencia_ruta ? `<button type="button" class="enlace" data-ver-foto="${esc(r.evidencia_ruta)}" style="text-align:left;padding-left:0">Ver evidencia</button>` : ""}
          <button type="button" class="secundario" data-reto-disputar="${r.id}">Disputar</button>`;
      if (["habito", "marca"].includes(r.tipo) && r.estado === "no_cumplido" && dentroDe48h(r.resuelto_en))
        acciones = `<button type="button" class="secundario" data-reto-esfuerzo="${r.id}">🌟 Reconocer su esfuerzo</button>
          <p class="ayuda">Si mejoró aunque no llegó a la meta, puedes darlo por cumplido.</p>`;
      bloques.push(`<span class="grupo-titulo">Tu reto para ${otro} (semana del ${fechaCorta(r.semana)})</span>` + tarjetaReto(r, acciones));
    }

    if (miPropuesta) bloques.push(`<span class="grupo-titulo">Tu reto para ${otro} (semana del ${fechaCorta(miPropuesta.semana)})</span>` + tarjetaReto(miPropuesta));
    else if (d.puede_proponer) bloques.push(`
      <span class="grupo-titulo">Proponle un reto a ${otro} para la próxima semana</span>
      <div class="chips" id="rt-tipo" style="margin-bottom:12px">
        ${Object.entries(TIPO_RETO).map(([k, [e, n]], i) => `<button type="button" data-rt-tipo="${k}" aria-pressed="${i === 0}">${e} ${n}</button>`).join("")}
      </div>
      <div id="rt-entreno" hidden>
        <select id="rt-entreno-tipo" class="campo">${TIPOS.map(([k, e, n]) => `<option value="${k}">${e} ${n}</option>`).join("")}</select>
        <div id="rt-zonas-c" hidden><span class="grupo-titulo">Zona (opcional)</span>
          <div class="chips" id="rt-zonas" style="margin-bottom:12px">${ZONAS_CUERPO.map(([k, n]) => `<button type="button" data-rt-zona="${k}" aria-pressed="false">${n}</button>`).join("")}</div></div>
      </div>
      <textarea id="rt-desc" maxlength="300" placeholder="${EJEMPLO_RETO.entrenamiento}"></textarea>
      <input id="rt-obj" maxlength="120" placeholder="Meta concreta (ej.: 60 kg en sentadilla)" hidden style="margin-top:10px">
      <p class="ayuda">Hasta el domingo a las ${String(d.limite_propuesta).slice(11, 16)} en la hora de ${otro}. No se permiten retos sobre peso corporal ni calorías.</p>
      <button type="button" class="secundario" id="rt-enviar">Proponer reto</button>`);
    else bloques.push(`<p class="ayuda">El plazo para proponer el reto de la próxima semana ya terminó.</p>`);

    const historial = d.retos.filter((r) => !["propuesto", "aceptado"].includes(r.estado) && r.semana < sumarDias(d.semana_yo, -7)).slice(0, 6);
    cont.innerHTML = `
      <h3>🎯 Retos</h3>
      <div class="bloques-retos">${bloques.join("")}</div>
      ${historial.length ? `<details class="historial"><summary>Retos anteriores</summary>${historial.map((r) => `<p class="ayuda">${TIPO_RETO[r.tipo][0]} ${esc(r.descripcion)} · ${r.retado === yoId ? "para ti" : "para " + otro} · ${ESTADO_RETO[r.estado]}</p>`).join("")}</details>` : ""}`;

    let tipoNuevo = "entrenamiento";
    $("rt-tipo")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-rt-tipo]"); if (!b) return;
      tipoNuevo = b.dataset.rtTipo;
      $("rt-tipo").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
      $("rt-desc").placeholder = EJEMPLO_RETO[tipoNuevo];
      $("rt-obj").hidden = tipoNuevo !== "marca";
      $("rt-entreno").hidden = tipoNuevo !== "entreno_especifico";
      pintarZonasReto();
    });
    let zonaReto = null;
    const pintarZonasReto = () => {
      const t = $("rt-entreno-tipo")?.value;
      if ($("rt-zonas-c")) $("rt-zonas-c").hidden = !CON_ZONAS.includes(t);
      if (!CON_ZONAS.includes(t)) zonaReto = null;
      $("rt-zonas")?.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.rtZona === zonaReto));
    };
    $("rt-entreno-tipo")?.addEventListener("change", pintarZonasReto);
    $("rt-zonas")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-rt-zona]"); if (!b) return;
      zonaReto = zonaReto === b.dataset.rtZona ? null : b.dataset.rtZona;
      pintarZonasReto();
    });
    $("rt-enviar")?.addEventListener("click", async (e) => {
      const tEnt = $("rt-entreno-tipo")?.value;
      const autoEntreno = tipoNuevo === "entreno_especifico"
        ? `Entrenar ${zonaReto ? ZONA_NOMBRE[zonaReto].toLowerCase() + " (" + TIPO[tEnt].nombre.toLowerCase() + ")" : TIPO[tEnt].nombre.toLowerCase()} al menos un día`
        : "";
      const desc = $("rt-desc").value.trim() || (tipoNuevo === "entrenamiento" ? EJEMPLO_RETO.entrenamiento : autoEntreno);
      if (!desc) return avisar("Describe el reto.");
      e.target.disabled = true;
      const r = await db.rpc("proponer_reto", {
        p_tipo: tipoNuevo, p_descripcion: desc, p_objetivo: $("rt-obj").value || null,
        p_entreno_tipo: tipoNuevo === "entreno_especifico" ? tEnt : null,
        p_entreno_zona: tipoNuevo === "entreno_especifico" ? zonaReto : null
      });
      e.target.disabled = false;
      if (r.error) return avisar(errorLegible(r.error));
      avisar("Reto enviado. 🎯", "ok"); seccionRetos(cont);
    });
  }

  function hojaDeclarar(id, tipo, cumplido) {
    let foto = null;
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.6rem">${cumplido ? "¡Lo cumpliste!" : "No lo cumpliste"}</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">${cumplido ? "Tu pareja tendrá 48 horas para revisarlo." : "Tu pareja podrá reconocer tu esfuerzo si mejoraste."}</p>
      ${tipo === "marca" && cumplido ? `<div class="campo" id="dc-foto"><span class="grupo-titulo">Evidencia (obligatoria)</span>
        <label class="agregar-foto" style="aspect-ratio:auto;padding:22px"><input type="file" accept="image/*" id="dc-archivo">📷 Foto de la marca</label></div>` : ""}
      <div class="campo"><label for="dc-nota">Nota (opcional)</label><textarea id="dc-nota" maxlength="500" placeholder="Cómo te fue, qué aprendiste…"></textarea></div>
      <button type="button" class="boton-principal" id="dc-enviar">Confirmar</button>`);
    $("dc-archivo")?.addEventListener("change", (e) => {
      foto = e.target.files[0] || null;
      if (foto) $("dc-foto").innerHTML = `<div class="galeria"><img src="${URL.createObjectURL(foto)}" alt="Evidencia"></div>`;
    });
    $("dc-enviar").addEventListener("click", async (e) => {
      if (tipo === "marca" && cumplido && !foto) return avisar("Adjunta la foto de evidencia.");
      e.target.disabled = true;
      try {
        let ruta = null;
        if (foto) {
          ruta = `${usuario.id}/retos/${Date.now()}.jpg`;
          const up = await db.storage.from("evidencias").upload(ruta, await comprimir(foto, 1280, 0.75), { contentType: "image/jpeg" });
          if (up.error) throw up.error;
        }
        const r = await db.rpc("declarar_reto", { p_id: id, p_cumplido: cumplido, p_nota: $("dc-nota").value, p_evidencia: ruta });
        if (r.error) throw r.error;
        cerrarHoja(); avisar("Reto declarado.", "ok"); seccionRetos($("retos"));
      } catch (err) { e.target.disabled = false; avisar(errorLegible(err)); }
    });
  }

  async function accionesRetos(e) {
    const t = e.target;
    const resp = t.closest("[data-reto-resp]");
    if (resp) {
      resp.disabled = true;
      const r = await db.rpc("responder_reto", { p_id: Number(resp.dataset.id), p_acepta: resp.dataset.retoResp === "si" });
      if (r.error) { resp.disabled = false; return avisar(errorLegible(r.error)); }
      avisar(r.data === "aceptado" ? "¡Reto aceptado! 💪" : "Reto rechazado.", "ok");
      return irA(vistaActual);
    }
    const dec = t.closest("[data-reto-declarar]");
    if (dec) return hojaDeclarar(Number(dec.dataset.id), dec.dataset.tipo, dec.dataset.retoDeclarar === "si");
    const dis = t.closest("[data-reto-disputar]");
    if (dis) {
      const nota = prompt("¿Por qué disputas este reto? Tu pareja verá la nota.");
      if (nota === null) return;
      const r = await db.rpc("disputar_reto", { p_id: Number(dis.dataset.retoDisputar), p_nota: nota });
      if (r.error) return avisar(errorLegible(r.error));
      avisar("Reto disputado.", "ok"); return seccionRetos($("retos"));
    }
    const esf = t.closest("[data-reto-esfuerzo]");
    if (esf) {
      if (!confirm("¿Dar este reto por cumplido por su esfuerzo? Recibirá los mismos puntos que si lo hubiera cumplido.")) return;
      const r = await db.rpc("reconocer_esfuerzo", { p_id: Number(esf.dataset.retoEsfuerzo) });
      if (r.error) return avisar(errorLegible(r.error));
      avisar("¡Esfuerzo reconocido! 🌟", "ok"); return seccionRetos($("retos"));
    }
    const rec = t.closest("[data-disfrutar]");
    if (rec) {
      const nota = prompt("¿Cómo la disfrutaste? (opcional)");
      if (nota === null) return;
      const r = await db.rpc("disfrutar_recompensa", { p_id: Number(rec.dataset.disfrutar), p_nota: nota });
      if (r.error) return avisar(errorLegible(r.error));
      avisar("¡A disfrutarla! 🎁", "ok"); return vistaRecompensas();
    }
    const ed = t.closest("[data-editar-regla]");
    if (ed) return hojaRegla(Number(ed.dataset.editarRegla), ed.dataset.nombre, ed.dataset.desc);
    if (t.closest("[data-ir-recompensas]")) return vistaRecompensas();
  }
  $("vista").addEventListener("click", accionesRetos);
  $("hoja").addEventListener("click", accionesRetos);

  // ---------- Recompensas
  async function tarjetaRecompensas(cont) {
    if (!cont) return;
    const { data: d } = await db.rpc("estado_retos");
    if (!d) { cont.innerHTML = ""; return; }
    const disponibles = d.recompensas.filter((r) => r.user_id === usuario.id && r.estado === "disponible").length;
    const propuestoAMi = d.retos.find((r) => r.retado === usuario.id && r.estado === "propuesto");
    cont.innerHTML = `
      ${propuestoAMi ? `<section class="tarjeta pendiente"><h3>🎯 ${esc(pareja()?.nombre || "Tu pareja")} te propuso un reto</h3>
        <p>${TIPO_RETO[propuestoAMi.tipo][0]} ${esc(propuestoAMi.descripcion)}</p>
        <div class="acciones-juntos"><button type="button" data-reto-resp="si" data-id="${propuestoAMi.id}">Aceptar</button>
        <button type="button" class="secundario" style="margin:0" data-reto-resp="no" data-id="${propuestoAMi.id}">Rechazar</button></div></section>` : ""}
      <button type="button" class="item" data-ir-recompensas style="margin-bottom:14px">
        <span class="mini">🎁</span>
        <span><strong>Recompensas${disponibles ? ` <span class="burbuja-num">${disponibles}</span>` : ""}</strong>
          <span class="meta">${d.rachas.yo.mensual} mes(es) perfecto(s) seguidos · ${disponibles ? "tienes recompensas por disfrutar" : "cumple tu mes para desbloquear"}</span></span>
        <span class="lado">›</span>
      </button>`;
  }

  async function vistaRecompensas() {
    vistaActual = "recompensas";
    document.querySelectorAll("#pestanas button").forEach((b) => {
      if (b.dataset.vista === "mas") b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    $("vista").innerHTML = `<div class="cabecera-vista"><h2 class="titulo">Recompensas</h2><button type="button" data-accion="volver-inicio">Volver</button></div><p class="sub">Cargando…</p>`;
    const { data: d, error } = await db.rpc("estado_retos");
    if (error || !d) return avisar("No se pudieron cargar las recompensas.");
    const racha = d.rachas.yo.mensual;
    const siguiente = d.reglas.map((r) => r.meses).filter((m) => m > 1).find((m) => racha < m) || null;
    const mias = d.recompensas.filter((r) => r.user_id === usuario.id);
    const suyas = d.recompensas.filter((r) => r.user_id !== usuario.id);
    const fila = (r, mia) => `
      <div class="tarjeta" style="margin:0">
        <h3>🎁 ${esc(r.nombre)}</h3>
        <span class="etiqueta">${r.estado === "disponible" ? "Disponible" : "Disfrutada"}</span><span class="etiqueta">${fmt(r.mes, { month: "long", year: "numeric" })}</span>
        <p>${esc(r.descripcion || "")}</p>
        ${r.comida_libre && r.estado === "disponible" ? `<p class="ayuda">La comida libre extra se podrá usar en el registro de comidas (fase 8).</p>` : ""}
        ${r.nota ? `<p class="ayuda">${esc(r.nota)}</p>` : ""}
        ${mia && r.estado === "disponible" ? `<button type="button" class="secundario" data-disfrutar="${r.id}">Marcar como disfrutada</button>` : ""}
      </div>`;
    $("vista").innerHTML = `
      <div class="cabecera-vista"><h2 class="titulo">Recompensas</h2><button type="button" data-accion="volver-inicio">Volver</button></div>
      <p class="sub">Se desbloquean con meses perfectos seguidos: todos tus entrenamientos obligatorios cumplidos.</p>
      <section class="tarjeta">
        <h3>🏅 ${racha} mes${racha === 1 ? "" : "es"} perfecto${racha === 1 ? "" : "s"} seguido${racha === 1 ? "" : "s"}</h3>
        <p>${siguiente ? `Te faltan ${siguiente - racha} para la recompensa de ${siguiente} meses.` : "¡Sigue así!"}</p>
      </section>
      <h3 style="margin:22px 0 10px">Tus recompensas</h3>
      <div class="lista">${mias.length ? mias.map((r) => fila(r, true)).join("") : `<p class="vacio">Aún no hay recompensas. ¡El primer mes perfecto desbloquea la primera!</p>`}</div>
      ${suyas.length ? `<h3 style="margin:22px 0 10px">Las de ${esc(pareja()?.nombre || "tu pareja")}</h3><div class="lista">${suyas.map((r) => fila(r, false)).join("")}</div>` : ""}
      <h3 style="margin:22px 0 10px">Qué se puede ganar</h3>
      <div class="lista">${d.reglas.map((r) => `
        <div class="tarjeta" style="margin:0">
          <h3>${r.meses} mes${r.meses === 1 ? "" : "es"} seguido${r.meses === 1 ? "" : "s"}: ${esc(r.nombre)}</h3>
          <p>${esc(r.descripcion || "")}</p>
          <button type="button" class="enlace" style="text-align:left;padding-left:0" data-editar-regla="${r.id}" data-nombre="${esc(r.nombre)}" data-desc="${esc(r.descripcion || "")}">Editar</button>
        </div>`).join("")}</div>
      <p class="ayuda" style="margin-top:12px">Cada recompensa se repite: la de 3 meses vuelve a los 6, 9, 12…</p>`;
  }

  function hojaRegla(id, nombre, desc) {
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.6rem">Editar recompensa</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">Acuérdenlo entre los dos: el cambio lo ven ambos.</p>
      <div class="campo"><label for="rg-nombre">Nombre</label><input id="rg-nombre" maxlength="80" value="${nombre}"></div>
      <div class="campo"><label for="rg-desc">Descripción</label><textarea id="rg-desc" maxlength="300">${desc}</textarea></div>
      <button type="button" class="boton-principal" id="rg-guardar-regla">Guardar</button>`);
    $("rg-guardar-regla").addEventListener("click", async () => {
      const r = await db.from("reglas_recompensa").update({ nombre: $("rg-nombre").value.trim(), descripcion: $("rg-desc").value.trim() || null }).eq("id", id);
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja(); avisar("Recompensa actualizada.", "ok"); vistaRecompensas();
    });
  }

  // ================================================================ COMIDA (fase 8)
  const CATEGORIAS = [["desayuno", "🥐", "Desayuno"], ["almuerzo", "🍽️", "Almuerzo"], ["snack", "🍎", "Snack"],
    ["cena", "🌙", "Cena"], ["postre", "🍰", "Postre"], ["otra", "🥄", "Otra"]];
  const CAT = Object.fromEntries(CATEGORIAS.map(([k, e, n]) => [k, { emoji: e, nombre: n }]));
  const CONTEXTOS = [["casa", "🏠 En casa"], ["restaurante", "🍴 Restaurante"], ["delivery", "🛵 Delivery"], ["rapida", "🍔 Comida rápida"], ["otro", "✨ Otro"]];
  const CONTEXTO = Object.fromEntries(CONTEXTOS);
  const SENTIMIENTOS = [["hambre", "😋 Con hambre"], ["satisfecho", "😊 Satisfecho"], ["lleno", "😮‍💨 Lleno"], ["orgulloso", "🌟 Orgulloso"], ["culpable", "😔 Culpable"]];
  const SENTIMIENTO = Object.fromEntries(SENTIMIENTOS);
  const NUTRIS = [["proteina", "Proteína"], ["carbohidratos", "Carbohidratos"], ["azucares", "Azúcares"], ["grasas", "Grasas"], ["fibra", "Fibra"]];
  const r1 = (n) => Math.round(Number(n || 0) * 10) / 10;
  let comidaFecha = null, comidaDe = "yo";

  async function urlsComidas(rutas) {
    if (!rutas.length) return {};
    const { data } = await db.storage.from("comidas").createSignedUrls(rutas, 3600);
    return Object.fromEntries((data || []).filter((x) => x.signedUrl).map((x) => [x.path, x.signedUrl]));
  }
  const fotoVigente = (c) => c.foto_ruta && !c.foto_borrada && c.foto_hasta && new Date(c.foto_hasta) > new Date();

  function barraNutriente(nombre, valor, obj, unidad) {
    let txt = `${r1(valor)} ${unidad}`, pctB = 0, ok = null;
    if (obj) {
      const min = obj.valor_min != null ? Number(obj.valor_min) : null, max = obj.valor_max != null ? Number(obj.valor_max) : null;
      if (obj.tipo === "maximo") { pctB = Math.min(100, (valor / max) * 100); ok = valor <= max; txt += ` / máx. ${r1(max)}`; }
      if (obj.tipo === "minimo") { pctB = Math.min(100, (valor / min) * 100); ok = valor >= min; txt += ` / mín. ${r1(min)}`; }
      if (obj.tipo === "rango") { pctB = Math.min(100, (valor / max) * 100); ok = valor >= min && valor <= max; txt += ` / ${r1(min)}–${r1(max)}`; }
    }
    return `
      <div class="nutri-fila">
        <div class="nutri-cab"><span>${nombre}</span><strong>${txt}${ok === null ? "" : ok ? " ✓" : ""}</strong></div>
        ${obj ? `<div class="progreso"><span style="width:${pctB}%;${ok === false && obj.tipo !== "minimo" ? "background:var(--error)" : ""}"></span></div>` : ""}
      </div>`;
  }

  function itemComida(c, urls, kcal) {
    const cat = CAT[c.categoria];
    if (c.estado === "preparada") {
      const fotoP = fotoVigente(c) ? urls[c.foto_ruta] : null;
      return `
      <div class="item preparada" style="grid-template-columns:56px minmax(0,1fr)">
        <span class="mini" ${fotoP ? `style="background-image:url('${fotoP}')"` : ""}>${fotoP ? "" : "📦"}</span>
        <span><strong>📦 ${esc(c.nombre)}</strong><span class="meta">${cat.nombre} preparada${kcal != null ? ` · 🔒 ${Math.round(kcal)} kcal` : ""}</span>
          ${c.fecha <= yo().hoy ? `<span class="acciones-fila"><button type="button" data-prep-si="${c.id}">✓ Me la comí</button><button type="button" data-prep-no="${c.id}">No me la comí</button></span>`
            : `<span class="etiqueta">Para mañana</span>`}</span>
      </div>`;
    }
    if (c.saltada) return `
      <button type="button" class="item" data-comida="${c.id}" style="min-height:56px">
        <span class="mini">⏭️</span><span><strong>${cat.nombre} saltado</strong><span class="meta">${c.hora ? c.hora.slice(0, 5) : ""}</span></span><span></span>
      </button>`;
    const foto = fotoVigente(c) ? urls[c.foto_ruta] : null;
    return `
      <button type="button" class="item" data-comida="${c.id}">
        <span class="mini" ${foto ? `style="background-image:url('${foto}')"` : ""}>${foto ? "" : cat.emoji}</span>
        <span><strong>${cat.emoji} ${esc(c.nombre)}</strong>
          <span class="meta">${cat.nombre}${c.hora ? " · " + c.hora.slice(0, 5) : ""}${kcal != null ? ` · 🔒 ${Math.round(kcal)} kcal` : ""}</span>
          ${c.es_libre ? `<span class="etiqueta etiqueta-aviso">🍕 Comida libre · no saludable</span>` : c.saludable ? `<span class="etiqueta etiqueta-ok">🥗 Saludable</span>` : `<span class="etiqueta">No saludable</span>`}
          ${c.contexto ? `<span class="etiqueta">${CONTEXTO[c.contexto]}</span>` : ""}
          ${c.juntos === "confirmado" ? `<span class="etiqueta">💞 Juntos</span>` : c.juntos === "pendiente" ? `<span class="etiqueta">Juntos: por confirmar</span>` : ""}
          ${!foto ? `<span class="etiqueta">Foto expirada</span>` : ""}
        </span>
        <span class="lado">${c.sentimiento ? SENTIMIENTO[c.sentimiento].split(" ")[0] : ""}</span>
      </button>`;
  }

  async function vistaComida() {
    vistaActual = "comida";
    const y = yo(), p = pareja();
    if (!comidaFecha) comidaFecha = y.hoy;
    const quien = comidaDe === "yo" ? y : p;
    const esHoy = comidaFecha === y.hoy;
    $("vista").innerHTML = `
      <h2 class="titulo">Comida</h2>
      <div class="nav-dia">
        <button type="button" data-dia-comida="-1" aria-label="Día anterior">‹</button>
        <strong>${etiquetaFecha(comidaFecha)}${esHoy || comidaFecha === sumarDias(y.hoy, -1) ? "" : ""}</strong>
        <button type="button" data-dia-comida="1" aria-label="Día siguiente" ${esHoy ? "disabled" : ""}>›</button>
      </div>
      <div class="segmentado" role="group" aria-label="Ver comidas de">
        <button type="button" data-comida-de="yo" aria-pressed="${comidaDe === "yo"}">Mi día</button>
        <button type="button" data-comida-de="pareja" aria-pressed="${comidaDe === "pareja"}">${esc(p?.nombre || "Pareja")}</button>
      </div>
      <div id="comida-contenido"><p class="vacio">Cargando…</p></div>`;
    if (!quien) return;
    const { data: d, error } = await db.rpc("resumen_dia_comida", { p_user: quien.id, p_fecha: comidaFecha });
    if (error || !d) { $("comida-contenido").innerHTML = ""; return avisar("No se pudo cargar el día: " + errorLegible(error) + ". ¿Ejecutaste fase8.sql?"); }
    if (vistaActual !== "comida") return;
    const urls = await urlsComidas(d.comidas.filter(fotoVigente).map((c) => c.foto_ruta));
    const esMio = comidaDe === "yo";
    const editable = esMio && (comidaFecha >= sumarDias(y.hoy, -1) || antesDelInicio());
    const regla = d.comidas_max ? `${d.n_comidas} comida${d.n_comidas === 1 ? "" : "s"} · máximo ${d.comidas_max}${d.n_comidas > d.comidas_max ? " ⚠️" : " ✓"}`
      : d.comidas_min ? `${d.n_comidas} comida${d.n_comidas === 1 ? "" : "s"} · mínimo ${d.comidas_min}${d.n_comidas >= d.comidas_min ? " ✓" : d.cerrado ? " ⚠️" : ""}`
      : `${d.n_comidas} comida${d.n_comidas === 1 ? "" : "s"}`;
    const mes = d.mes || {};
    const lib = d.libres;
    const objetivos = Object.fromEntries((d.objetivos || []).map((o) => [o.nutriente, o]));
    $("comida-contenido").innerHTML = `
      <section class="tarjeta">
        <span class="puntos-etiqueta">Alimentación saludable ${esHoy ? "hoy" : "del día"}</span>
        <div class="cifra">${d.pct == null ? "—" : Math.round(d.pct) + " %"}</div>
        ${d.dia_libre ? `<p>🎉 Día libre: lo saludable suma y lo demás no resta.</p>` : ""}
        <p>${regla}${d.cerrado ? " · día cerrado" : ""}</p>
        <p>Este mes: <strong>${mes.pct == null ? "—" : Math.round(mes.pct) + " %"}</strong>${mes.dias ? ` · ${mes.con_registro} día${mes.con_registro === 1 ? "" : "s"} con registro` : ""}</p>
        ${esMio && lib ? `<p>🍕 Comidas libres: quedan <strong>${lib.quedan}</strong> de ${lib.total} este mes${lib.recompensa ? " · 🎁 +1 de recompensa" : ""}${lib.regalo_juntos ? " · 💞 hoy tienen una de regalo" : ""}</p>` : ""}
      </section>
      ${d.macros || d.kcal != null ? `
      <section class="tarjeta">
        <h3>${esMio ? "🔒 Nutrición del día" : "Macros que comparte"}</h3>
        ${esMio ? `<p class="ayuda" style="margin:0 0 6px">${d.tipo_dia === "entreno" ? "🏋️ Día de entreno" : "😌 Día de descanso"}${objetivos.calorias?.checkin ? " · calorías del check-in semanal" : ""}</p>` : ""}
        ${esMio ? barraNutriente("Calorías", Number(d.kcal) + Number(d.kcal_alcohol || 0), objetivos.calorias, "kcal") : ""}
        ${esMio && Number(d.kcal_alcohol) > 0 ? `<p class="ayuda" style="margin:0">Incluye ${Math.round(d.kcal_alcohol)} kcal de alcohol 🍷</p>` : ""}
        ${NUTRIS.map(([k, n]) => barraNutriente(n, d.macros?.[k] || 0, esMio ? objetivos[k] : null, "g")).join("")}
        ${d.macros ? `<p class="ayuda">Carbohidratos netos: <strong>${r1((d.macros.carbohidratos || 0) - (d.macros.fibra || 0))} g</strong>${esMio ? ` · Calorías según macros: ${Math.round(4 * (d.macros.proteina || 0) + 4 * (d.macros.carbohidratos || 0) + 9 * (d.macros.grasas || 0))} kcal` : ""}</p>` : ""}
        ${esMio && d.micros ? `<details class="historial"><summary>Micronutrientes</summary>${MICRO.map(([k, n, u]) => `<div class="nutri-cab" style="padding:6px 0"><span>${n}</span><strong>${r1(d.micros[k])} ${u}</strong></div>`).join("")}
          <p class="ayuda">Solo cuentan los alimentos que traen ese dato (bases de datos, etiquetas o IA).</p></details>` : ""}
        ${esMio ? `<p class="ayuda">Solo tú ves las calorías${perfil.compartir_macros ? "; tus macros los ve también tu pareja" : " y los macros"}. Puedes cambiarlo en Perfil.</p>` : ""}
      </section>` : ""}
      ${esMio ? `<section class="tarjeta">
        <div class="nutri-cab"><h3 style="margin:0">💧 Agua</h3><strong>${d.agua_ml} ml${d.agua_meta ? ` / ${d.agua_meta}` : ""}</strong></div>
        ${d.agua_meta ? `<div class="progreso"><span style="width:${Math.min(100, (d.agua_ml / d.agua_meta) * 100)}%;background:var(--azul)"></span></div>` : ""}
        ${editable ? `<div class="chips" style="margin-top:12px"><button type="button" data-agua="250">+250 ml</button><button type="button" data-agua="500">+500 ml</button><button type="button" data-agua="deshacer">Deshacer</button></div>` : ""}
      </section>` : ""}
      ${esMio && esHoy ? `<div class="acciones-juntos" style="margin-bottom:14px">
        <button type="button" class="secundario" style="margin:0" data-ir="recetas">🍲 Recetas</button>
        <button type="button" class="secundario" style="margin:0" data-ir="checkin">📈 Check-in</button></div>` : ""}
      <div id="comidas-pendientes"></div>
      ${editable ? `
        <button type="button" class="boton-principal" data-accion-comida="nueva">Registrar comida</button>
        ${esHoy && perfil.coach_activo ? `<button type="button" class="secundario" data-accion-comida="que-comer">🤖 ¿Qué como ahora?</button>` : ""}
        <div class="acciones-juntos" style="margin:10px 0 18px">
          <button type="button" class="secundario" style="margin:0" data-accion-comida="saltada">⏭️ Comida saltada</button>
          ${!d.cerrado ? `<button type="button" class="secundario" style="margin:0" data-accion-comida="cerrar">✅ Cerrar mi día</button>` : `<button type="button" class="secundario" style="margin:0" disabled>Día cerrado ✓</button>`}
        </div>` : ""}
      <div class="lista">${d.comidas.length ? d.comidas.map((c) => itemComida(c, urls, esMio ? d.kcal_por_comida?.[c.id] : null)).join("")
        : `<p class="vacio">${esMio ? "Aún no registraste comidas este día." : "Sin comidas registradas este día."}</p>`}</div>`;
    if (esMio) cargarComidasPendientes();
    if (esMio && esHoy) {
      const { data: man } = await db.from("comidas").select("id, nombre, categoria").eq("user_id", usuario.id).eq("estado", "preparada").eq("fecha", sumarDias(y.hoy, 1));
      if (man?.length) $("comida-contenido").insertAdjacentHTML("beforeend", `<p class="ayuda" style="margin-top:14px">📦 Preparadas para mañana: ${man.map((c) => `${CAT[c.categoria].emoji} ${esc(c.nombre)}`).join(", ")}.</p>`);
    }
  }

  async function cargarComidasPendientes() {
    const p = pareja(); const cont = $("comidas-pendientes");
    if (!p || !cont) return;
    const { data } = await db.from("comidas").select("id, nombre, fecha, categoria").eq("user_id", p.id).eq("juntos", "pendiente")
      .eq("estado", "completa").gte("fecha", sumarDias(yo().hoy, -2));
    cont.innerHTML = (data || []).map((c) => `
      <section class="tarjeta pendiente"><h3>💞 ¿Comieron juntos?</h3>
        <p>${esc(p.nombre)} registró ${CAT[c.categoria].emoji} ${esc(c.nombre)} (${etiquetaFecha(c.fecha).toLowerCase()}) como comida juntos.</p>
        <div class="acciones-juntos"><button type="button" data-comida-juntos="si" data-id="${c.id}">Confirmar</button>
          <button type="button" class="secundario" style="margin:0" data-comida-juntos="no" data-id="${c.id}">No fue juntos</button></div>
      </section>`).join("");
  }

  // ---------- Detalle de una comida
  async function verComida(id) {
    const { data: c, error } = await db.from("comidas").select("*").eq("id", id).single();
    if (error) return avisar(errorLegible(error));
    const esMio = c.user_id === usuario.id;
    const items = esMio ? (await db.from("comida_items").select("*").eq("comida_id", id)).data || [] : [];
    const comentario = esMio ? (await db.from("coach_comentarios").select("texto").eq("comida_id", id).maybeSingle()).data?.texto : null;
    const url = fotoVigente(c) ? (await urlsComidas([c.foto_ruta]))[c.foto_ruta] : null;
    const editable = esMio && (c.fecha >= sumarDias(yo().hoy, -1) || antesDelInicio());
    const tot = (k) => items.reduce((a, i) => a + Number(i[k] || 0), 0);
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">${CAT[c.categoria].emoji} ${c.saltada ? CAT[c.categoria].nombre + " saltado" : esc(c.nombre)}</h2>
        <button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub" style="margin-bottom:8px">${etiquetaFecha(c.fecha)}${c.hora ? " · " + c.hora.slice(0, 5) : ""}</p>
      ${!c.saltada ? `
        ${c.es_libre ? `<span class="etiqueta etiqueta-aviso">🍕 Comida libre${c.libre_origen === "juntos" ? " de regalo" : c.libre_origen === "recompensa" ? " de recompensa" : ""} · no saludable</span>` : c.saludable ? `<span class="etiqueta etiqueta-ok">🥗 Saludable</span>` : `<span class="etiqueta">No saludable</span>`}
        ${c.contexto ? `<span class="etiqueta">${CONTEXTO[c.contexto]}</span>` : ""}
        ${c.sentimiento ? `<span class="etiqueta">${SENTIMIENTO[c.sentimiento]}</span>` : ""}
        <div class="galeria">${url ? `<img src="${url}" alt="Foto de la comida">` : `<p class="vacio">La foto ya no está disponible (se borra a las 24 horas).</p>`}</div>` : ""}
      ${esMio && items.length ? `<section class="tarjeta"><h3>🔒 Alimentos</h3>
        ${items.map((i) => `<div class="fila-stat" style="grid-template-columns:minmax(0,1fr) auto"><span>${esc(i.nombre)} <small>×${r1(i.cantidad)}${i.unidad ? " " + esc(i.unidad) : ""}</small></span><strong>${Math.round(i.kcal)} kcal</strong></div>`).join("")}
        <p class="ayuda">Total: ${Math.round(tot("kcal"))} kcal · P ${r1(tot("proteina"))} g · C ${r1(tot("carbohidratos"))} g · Az ${r1(tot("azucares"))} g · G ${r1(tot("grasas"))} g · F ${r1(tot("fibra"))} g</p></section>` : ""}
      ${c.notas ? `<section class="tarjeta"><h3>Notas</h3><p>${esc(c.notas)}</p></section>` : ""}
      ${comentario ? `<section class="tarjeta"><h3>🤖 Coach</h3><p class="coach-texto">${esc(comentario)}</p></section>` : ""}
      ${!esMio && c.juntos === "pendiente" ? `<div class="acciones-juntos"><button type="button" data-comida-juntos="si" data-id="${c.id}">Comimos juntos</button>
        <button type="button" class="secundario" style="margin:0" data-comida-juntos="no" data-id="${c.id}">No fue juntos</button></div>` : ""}
      ${esMio && !c.saltada ? `<button type="button" class="secundario" data-copiar-comida="${c.id}" style="margin-top:16px">📋 Copiar a hoy</button>` : ""}
      ${editable ? `<div class="acciones-juntos" style="margin-top:10px">
        ${!c.saltada ? `<button type="button" class="secundario" style="margin:0" data-editar-comida="${c.id}">Editar</button>` : ""}
        <button type="button" class="secundario" style="margin:0;color:var(--error)" data-borrar-comida="${c.id}">Eliminar</button></div>` : ""}`);
  }

  // ---------- Formulario de comida (nueva o edición)
  async function vistaFormComida(editId, copiarId = null) {
    vistaActual = "comida-form";
    const y = yo();
    const fecha = comidaFecha || y.hoy;
    let base = null, itemsBase = [];
    if (editId) {
      base = (await db.from("comidas").select("*").eq("id", editId).single()).data;
      itemsBase = (await db.from("comida_items").select("*").eq("comida_id", editId)).data || [];
    }
    const [res, anteriores] = await Promise.all([
      db.rpc("resumen_dia_comida", { p_user: usuario.id, p_fecha: fecha }),
      db.from("comidas").select("id, nombre, categoria, contexto, saludable").eq("user_id", usuario.id).eq("estado", "completa")
        .eq("saltada", false).order("creado_en", { ascending: false }).limit(40)
    ]);
    const lib = res.data?.libres || {};
    const ahora = new Date();
    const f = {
      categoria: base?.categoria || null, saludable: base ? base.saludable : true, contexto: base?.contexto || null,
      sentimiento: base?.sentimiento || null, libre: base?.es_libre || false, juntos: base ? base.juntos !== "no" : false,
      foto: null, items: itemsBase.map((i) => ({ ...i }))
    };
    const libreDisponible = f.libre || (!lib.usada_hoy && (lib.quedan > 0 || lib.recompensa || lib.regalo_juntos));
    const vistos = new Set();
    const previas = (anteriores.data || []).filter((c) => !vistos.has(c.nombre) && vistos.add(c.nombre)).slice(0, 20);

    $("vista").innerHTML = `
      <div class="cabecera-vista"><h2 class="titulo">${editId ? "Editar comida" : "Registrar comida"}</h2><button type="button" data-accion-comida="volver">Cancelar</button></div>
      <p class="sub">${etiquetaFecha(fecha)}${editId ? "" : " · La foto es obligatoria y se borra a las 24 horas."}</p>
      ${!editId && previas.length ? `<section class="tarjeta"><label for="cf-copiar">Repetir una comida anterior (opcional)</label>
        <select id="cf-copiar"><option value="">Elegir…</option>${previas.map((c) => `<option value="${c.id}">${CAT[c.categoria].emoji} ${esc(c.nombre)}</option>`).join("")}</select></section>` : ""}
      <section class="tarjeta">
        <span class="grupo-titulo">Comida</span>
        <div class="chips" id="cf-cat">${CATEGORIAS.map(([k, e, n]) => `<button type="button" data-cf-cat="${k}" aria-pressed="${f.categoria === k}">${e} ${n}</button>`).join("")}</div>
        <div class="fila campo" style="margin-top:14px">
          <div><label for="cf-nombre">Nombre</label><input id="cf-nombre" maxlength="120" value="${esc(base?.nombre || "")}" placeholder="Ej.: Pollo con arroz"></div>
          <div><label for="cf-hora">Hora</label><input id="cf-hora" type="time" value="${base?.hora ? base.hora.slice(0, 5) : String(ahora.getHours()).padStart(2, "0") + ":" + String(ahora.getMinutes()).padStart(2, "0")}"></div>
        </div>
        <span class="grupo-titulo">Foto ${editId ? "(opcional: reemplazar)" : "(obligatoria)"}</span>
        <div id="cf-foto"><label class="agregar-foto" style="aspect-ratio:auto;padding:22px"><input type="file" accept="image/*" id="cf-archivo">📷 Tomar o elegir foto</label></div>
      </section>
      <section class="tarjeta">
        ${!editId && fecha === y.hoy ? `<label class="interruptor" style="margin-bottom:12px"><span>📦 La preparé para mañana</span><input id="cf-preparada" type="checkbox"></label>
        <p class="ayuda" style="margin:-4px 0 14px">Regístrala ahora, cuando la pesas y empacas. Mañana solo confirmas que te la comiste.</p>` : ""}
        <label class="interruptor"><span>🍕 Es mi comida libre</span><input id="cf-libre" type="checkbox" ${f.libre ? "checked" : ""} ${libreDisponible ? "" : "disabled"}></label>
        <p class="ayuda">${lib.usada_hoy && !f.libre ? "Ya usaste la comida libre de hoy." : !libreDisponible ? "No te quedan comidas libres este mes." :
          `Quedan ${lib.quedan} de ${lib.total} este mes${lib.recompensa ? " · 🎁 +1 de recompensa" : ""}${lib.regalo_juntos ? " · 💞 hoy hay una de regalo si comen juntos" : ""}. Máximo una por día.`}</p>
        <div id="cf-saludable-c" ${f.libre ? "hidden" : ""} style="margin-top:14px">
          <span class="grupo-titulo">¿Cómo la clasificas?</span>
          <div class="opciones" id="cf-saludable">
            <label><input type="radio" name="cf-sal" value="1" ${f.saludable ? "checked" : ""}><span>🥗 Saludable</span></label>
            <label><input type="radio" name="cf-sal" value="0" ${f.saludable === false ? "checked" : ""}><span>No saludable</span></label>
          </div>
        </div>
        <span class="grupo-titulo" style="margin-top:16px">¿Dónde?</span>
        <div class="chips" id="cf-contexto">${CONTEXTOS.map(([k, n]) => `<button type="button" data-cf-ctx="${k}" aria-pressed="${f.contexto === k}">${n}</button>`).join("")}</div>
        <label class="interruptor" style="margin-top:16px"><span>💞 Comimos juntos</span><input id="cf-juntos" type="checkbox" ${f.juntos ? "checked" : ""}></label>
      </section>
      <section class="tarjeta">
        <h3>🔒 Alimentos y nutrientes</h3>
        <p>Privado: tu pareja no ve calorías${perfil.compartir_macros ? "" : " ni macros"}.</p>
        <div id="cf-items" class="lista" style="margin-top:12px"></div>
        <div class="botones-alimento">
          <button type="button" class="secundario" data-cf-add="buscar">🔎 Buscar</button>
          <button type="button" class="secundario" data-cf-add="escanear">📷 Escanear código</button>
          <button type="button" class="secundario" data-cf-add="catalogo">📚 Mis alimentos</button>
          <button type="button" class="secundario" data-cf-add="manual">✏️ Escribir valores</button>
          ${perfil.coach_activo ? `<button type="button" class="secundario" data-cf-add="foto">🤖 Desde la foto</button>
          <button type="button" class="secundario" data-cf-add="describir">🤖 Describir</button>
          <button type="button" class="secundario" data-cf-add="etiqueta">📄 Leer etiqueta</button>` : ""}
        </div>
        <p class="ayuda" id="cf-total"></p>
        ${perfil.coach_activo ? `<p class="ayuda">Lo estimado por IA es aproximado: revisa las cantidades.</p>` : ""}
      </section>
      <section class="tarjeta">
        <span class="grupo-titulo">¿Cómo te sientes después de comer? (opcional)</span>
        <div class="chips" id="cf-sent">${SENTIMIENTOS.map(([k, n]) => `<button type="button" data-cf-sent="${k}" aria-pressed="${f.sentimiento === k}">${n}</button>`).join("")}</div>
        <div class="campo" style="margin-top:14px"><label for="cf-notas">Notas</label><textarea id="cf-notas" maxlength="500">${esc(base?.notas || "")}</textarea></div>
      </section>
      <button type="button" class="boton-principal" id="cf-guardar">${editId ? "Guardar cambios" : "Guardar comida"}</button>
      <button type="button" class="secundario" data-accion-comida="volver">Cancelar</button>`;

    const marcar = (cont, sel, attr, valor) => cont.querySelectorAll(sel).forEach((b) => b.setAttribute("aria-pressed", b.dataset[attr] === valor));
    const pintarItems = () => {
      $("cf-items").innerHTML = f.items.length ? f.items.map((i, n) => `
        <div class="item" style="grid-template-columns:minmax(0,1fr) auto;min-height:0">
          <span><strong>${esc(i.nombre)}</strong><span class="meta">${i.unidad === "g" ? r1(i.cantidad) + " g" : "×" + r1(i.cantidad) + (i.unidad ? " " + esc(i.unidad) : "")} · ${Math.round(i.kcal)} kcal · P ${r1(i.proteina)} · C ${r1(i.carbohidratos)} · G ${r1(i.grasas)}</span>
            ${i.fuente === "ia" ? `<span class="etiqueta etiqueta-aviso">🤖 Estimado</span>` : ""}</span>
          <button type="button" class="enlace" data-cf-quitar="${n}" style="width:auto;margin:0">Quitar</button>
        </div>`).join("") : `<p class="ayuda" style="margin:0">Sin alimentos todavía (opcional, pero necesario para contar calorías y macros).</p>`;
      const t = (k) => f.items.reduce((a, i) => a + Number(i[k] || 0), 0);
      $("cf-total").textContent = f.items.length ? `Total: ${Math.round(t("kcal"))} kcal · Proteína ${r1(t("proteina"))} g · Carbohidratos ${r1(t("carbohidratos"))} g · Azúcares ${r1(t("azucares"))} g · Grasas ${r1(t("grasas"))} g · Fibra ${r1(t("fibra"))} g` : "";
    };
    pintarItems();

    $("cf-cat").addEventListener("click", (e) => { const b = e.target.closest("[data-cf-cat]"); if (!b) return; f.categoria = b.dataset.cfCat; marcar($("cf-cat"), "button", "cfCat", f.categoria); });
    $("cf-contexto").addEventListener("click", (e) => { const b = e.target.closest("[data-cf-ctx]"); if (!b) return; f.contexto = f.contexto === b.dataset.cfCtx ? null : b.dataset.cfCtx; marcar($("cf-contexto"), "button", "cfCtx", f.contexto); });
    $("cf-sent").addEventListener("click", (e) => { const b = e.target.closest("[data-cf-sent]"); if (!b) return; f.sentimiento = f.sentimiento === b.dataset.cfSent ? null : b.dataset.cfSent; marcar($("cf-sent"), "button", "cfSent", f.sentimiento); });
    $("cf-libre").addEventListener("change", (e) => { f.libre = e.target.checked; $("cf-saludable-c").hidden = f.libre; });
    $("cf-archivo").addEventListener("change", (e) => {
      f.foto = e.target.files[0] || null;
      if (f.foto) $("cf-foto").innerHTML = `<div class="galeria"><img src="${URL.createObjectURL(f.foto)}" alt="Foto de la comida"></div>`;
    });
    $("cf-items").addEventListener("click", (e) => { const b = e.target.closest("[data-cf-quitar]"); if (!b) return; f.items.splice(Number(b.dataset.cfQuitar), 1); pintarItems(); });
    const copiarComida = async (id) => {
      const [{ data: c }, { data: its }] = await Promise.all([
        db.from("comidas").select("*").eq("id", id).single(), db.from("comida_items").select("*").eq("comida_id", id)]);
      if (!c) return;
      $("cf-nombre").value = c.nombre || ""; f.categoria = c.categoria; marcar($("cf-cat"), "button", "cfCat", f.categoria);
      f.contexto = c.contexto; marcar($("cf-contexto"), "button", "cfCtx", f.contexto);
      if (!f.libre) document.querySelector(`input[name="cf-sal"][value="${c.saludable ? 1 : 0}"]`).checked = true;
      f.items = (its || []).map(({ id: _i, comida_id: _c, ...resto }) => resto); pintarItems();
      avisar("Comida copiada: revisa las cantidades y agrega la foto.", "ok");
    };
    $("cf-copiar")?.addEventListener("change", (e) => { const id = Number(e.target.value); if (id) copiarComida(id); });
    if (copiarId) copiarComida(copiarId);

    // Añadir alimentos
    const agregar = (item) => { f.items.push(item); pintarItems(); };
    const agregarVarios = (lista) => { f.items.push(...lista); pintarItems(); };
    $("vista").querySelectorAll("[data-cf-add]").forEach((b) => b.addEventListener("click", () => {
      const a = b.dataset.cfAdd;
      if (a === "buscar") return hojaBuscar(agregar);
      if (a === "escanear") return hojaEscanear(agregar);
      if (a === "catalogo") return hojaCatalogo(agregar);
      if (a === "foto") return estimarFoto(f.foto, agregarVarios, b);
      if (a === "describir") return hojaDescribir(agregarVarios);
      if (a === "etiqueta") return hojaEtiqueta(agregar);
      return hojaManual(agregar);
    }));

    $("cf-guardar").addEventListener("click", async (ev) => {
      const boton = ev.target;
      const nombre = $("cf-nombre").value.trim();
      const saludable = f.libre ? false : document.querySelector('input[name="cf-sal"]:checked')?.value === "1";
      if (!f.categoria) return avisar("Elige qué comida es (desayuno, almuerzo…).");
      if (!nombre) return avisar("Escribe el nombre de la comida.");
      if (!editId && !f.foto) return avisar("Agrega la foto de la comida.");
      if (!f.libre && !document.querySelector('input[name="cf-sal"]:checked')) return avisar("Clasifícala como saludable o no saludable.");
      boton.disabled = true; boton.textContent = "Guardando…";
      const campos = { nombre, categoria: f.categoria, hora: $("cf-hora").value || null, saludable, contexto: f.contexto,
        sentimiento: f.sentimiento, es_libre: f.libre, notas: $("cf-notas").value.trim() || null };
      let id = editId, creada = false;
      try {
        if (!editId) {
          const preparada = $("cf-preparada")?.checked;
          const r = await db.from("comidas").insert({ ...campos, user_id: usuario.id, fecha: preparada ? sumarDias(fecha, 1) : fecha,
            juntos: $("cf-juntos").checked ? "pendiente" : "no" }).select("id").single();
          if (r.error) throw r.error;
          id = r.data.id; creada = true;
        } else {
          if (base.juntos === "no" && $("cf-juntos").checked) campos.juntos = "pendiente";
          if (base.juntos !== "no" && !$("cf-juntos").checked) campos.juntos = "no";
          const r = await db.from("comidas").update(campos).eq("id", editId);
          if (r.error) throw r.error;
        }
        if (f.foto) {
          boton.textContent = "Subiendo foto…";
          const ruta = `${usuario.id}/${id}-${Date.now()}.jpg`;
          const up = await db.storage.from("comidas").upload(ruta, await comprimir(f.foto, 1024, 0.65), { contentType: "image/jpeg" });
          if (up.error) throw up.error;
          const esPrep = $("cf-preparada")?.checked || base?.estado === "preparada";
          const r = await db.from("comidas").update({ foto_ruta: ruta, foto_borrada: false,
            foto_hasta: new Date(Date.now() + (esPrep ? 60 : 24) * 3600 * 1000).toISOString(), estado: esPrep ? "preparada" : "completa" }).eq("id", id);
          if (r.error) throw r.error;
        }
        if (editId) await db.from("comida_items").delete().eq("comida_id", id);
        if (f.items.length) {
          const r = await db.from("comida_items").insert(f.items.map((i) => ({
            comida_id: id, user_id: usuario.id, alimento_id: i.alimento_id || null, nombre: i.nombre, cantidad: i.cantidad || 1, unidad: i.unidad || null,
            fuente: i.fuente || (i.alimento_id ? "catalogo" : "manual"), gramos: i.gramos || null,
            ...Object.fromEntries(NKEYS.map((n) => [n, Number(i[n]) || 0])) })));
          if (r.error) throw r.error;
        }
        const fuePrep = $("cf-preparada")?.checked;
        avisar(fuePrep ? "Guardada para mañana. 📦 Mañana confirma que te la comiste." : editId ? "Comida actualizada." : "Comida guardada. 🍽️", "ok");
        irA("comida");
        if (!fuePrep) comentarComida(id, fecha);
      } catch (err) {
        if (creada) await db.from("comidas").delete().eq("id", id);
        boton.disabled = false; boton.textContent = editId ? "Guardar cambios" : "Guardar comida";
        avisar("No se pudo guardar: " + errorLegible(err));
      }
    });
  }

  // ---------- Hojas para añadir alimentos
  function camposNutrientes(pref = {}) {
    return `
      <div class="fila campo"><div><label for="mn-kcal">Calorías (kcal)</label><input id="mn-kcal" type="number" inputmode="decimal" min="0" value="${pref.kcal ?? ""}"></div>
        <div><label for="mn-proteina">Proteína (g)</label><input id="mn-proteina" type="number" inputmode="decimal" min="0" value="${pref.proteina ?? ""}"></div></div>
      <div class="fila campo"><div><label for="mn-carbohidratos">Carbohidratos (g)</label><input id="mn-carbohidratos" type="number" inputmode="decimal" min="0" value="${pref.carbohidratos ?? ""}"></div>
        <div><label for="mn-azucares">Azúcares (g)</label><input id="mn-azucares" type="number" inputmode="decimal" min="0" value="${pref.azucares ?? ""}"></div></div>
      <div class="fila campo"><div><label for="mn-grasas">Grasas (g)</label><input id="mn-grasas" type="number" inputmode="decimal" min="0" value="${pref.grasas ?? ""}"></div>
        <div><label for="mn-fibra">Fibra (g)</label><input id="mn-fibra" type="number" inputmode="decimal" min="0" value="${pref.fibra ?? ""}"></div></div>
      <details class="historial" style="margin:4px 0 16px"><summary>Micronutrientes (opcional)</summary>
        <div class="fila" style="margin-top:12px;row-gap:12px">${MICRO.map(([k, n, u]) => `<div><label for="mn-${k}">${n} (${u})</label><input id="mn-${k}" type="number" inputmode="decimal" min="0" value="${pref[k] ?? ""}"></div>`).join("")}</div>
      </details>`;
  }
  const leerNutrientes = () => Object.fromEntries(NKEYS.map((k) => [k, Number($("mn-" + k)?.value || 0)]));

  function hojaManual(agregar, codigo = null) {
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">Escribir valores</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">Los valores de la etiqueta o de una porción conocida.</p>
      ${codigo ? `<p class="aviso">Código ${esc(codigo)}: escribe los valores de la etiqueta y quedará guardado.</p>` : ""}
      <div class="fila campo"><div><label for="mn-nombre">Alimento</label><input id="mn-nombre" maxlength="120" placeholder="Ej.: Yogur griego"></div>
        <div><label for="mn-porcion">Porción</label><input id="mn-porcion" maxlength="40" placeholder="Ej.: 1 taza"></div></div>
      <div class="campo"><label for="mn-gramos">Gramos de esa porción (opcional)</label><input id="mn-gramos" type="number" inputmode="decimal" min="0" placeholder="Permite registrar por gramos después"></div>
      ${camposNutrientes()}
      <label class="interruptor"><span>Guardar en mis alimentos</span><input id="mn-guardar-cat" type="checkbox" checked></label>
      <button type="button" class="boton-principal" id="mn-ok" style="margin-top:14px">Añadir</button>`);
    $("mn-ok").addEventListener("click", async () => {
      const nombre = $("mn-nombre").value.trim();
      if (!nombre) return avisar("Escribe el nombre del alimento.");
      const n = leerNutrientes(), porcion = $("mn-porcion").value.trim() || "1 porción";
      let alimento_id = null;
      if ($("mn-guardar-cat").checked) {
        const gr = Number($("mn-gramos").value) || null;
        const r = await db.from("alimentos").upsert({ user_id: usuario.id, nombre, porcion, gramos: gr, codigo_barras: codigo, ...n }, { onConflict: "user_id,nombre,porcion" }).select("id").single();
        if (!r.error && r.data) alimento_id = r.data.id;
      }
      agregar({ alimento_id, nombre, cantidad: 1, unidad: porcion, fuente: alimento_id ? "catalogo" : "manual", gramos: Number($("mn-gramos").value) || null, ...n });
      cerrarHoja();
    });
  }

  async function hojaCatalogo(agregar) {
    const { data } = await db.from("alimentos").select("*").eq("user_id", usuario.id).order("veces_usado", { ascending: false }).order("nombre");
    const lista = data || [];
    let filtro = lista.some((a) => a.favorito) ? "favoritos" : "recientes";
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">Mis alimentos</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      ${lista.length ? `<div class="segmentado" id="ct-filtro"><button type="button" data-ctf="favoritos">⭐ Favoritos</button><button type="button" data-ctf="recientes">🕘 Recientes</button><button type="button" data-ctf="todos">Todos</button></div>
        <input id="ct-buscar" type="search" placeholder="Buscar…" style="margin-bottom:12px">
        <div class="lista" id="ct-lista"></div>` : `<p class="vacio">Todavía no guardaste alimentos. Usa "Escribir valores" y deja activado "Guardar en mis alimentos".</p>`}`);
    if (!lista.length) return;
    const pintar = (q = "") => {
      $("ct-filtro").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.ctf === filtro));
      let vista = lista.filter((a) => a.nombre.toLowerCase().includes(q.toLowerCase()));
      if (!q && filtro === "favoritos") vista = vista.filter((a) => a.favorito);
      if (!q && filtro === "recientes") vista = vista.filter((a) => a.ultimo_uso).sort((x, y) => (y.ultimo_uso > x.ultimo_uso ? 1 : -1)).slice(0, 25);
      $("ct-lista").innerHTML = vista.map((a) => `
        <div class="item" style="grid-template-columns:minmax(0,1fr) 92px;min-height:0">
          <span><strong><button type="button" class="estrella ${a.favorito ? "on" : ""}" data-ct-fav="${a.id}" aria-label="Favorito">★</button> ${esc(a.nombre)}</strong><span class="meta">${esc(a.porcion)} · ${Math.round(a.kcal)} kcal · P ${r1(a.proteina)} g</span></span>
          <span style="display:grid;gap:6px"><input type="number" inputmode="decimal" min="0.25" step="0.25" value="1" data-ct-cant="${a.id}" aria-label="Porciones" style="height:38px;padding:0 8px;text-align:center">
            <button type="button" data-ct-add="${a.id}" style="min-height:36px;font-size:.88rem">Añadir</button>
            ${a.gramos ? `<button type="button" class="enlace" data-ct-gramos="${a.id}" style="min-height:28px;font-size:.8rem;padding:0">En gramos</button>` : ""}
            <button type="button" class="enlace" data-ct-borrar="${a.id}" style="min-height:28px;font-size:.8rem;padding:0;color:var(--error)">Borrar</button></span>
        </div>`).join("") || `<p class="vacio">${filtro === "favoritos" && !q ? "Aún no tienes favoritos: toca la ★ de un alimento." : filtro === "recientes" && !q ? "Todavía no usaste alimentos guardados." : "Sin resultados."}</p>`;
    };
    $("ct-filtro").addEventListener("click", (e) => { const b = e.target.closest("[data-ctf]"); if (b) { filtro = b.dataset.ctf; pintar($("ct-buscar").value); } });
    pintar();
    $("ct-buscar").addEventListener("input", (e) => pintar(e.target.value));
    $("ct-lista").addEventListener("click", async (e) => {
      const fav = e.target.closest("[data-ct-fav]");
      if (fav) {
        const a = lista.find((x) => x.id === Number(fav.dataset.ctFav));
        a.favorito = !a.favorito;
        await db.from("alimentos").update({ favorito: a.favorito }).eq("id", a.id);
        return pintar($("ct-buscar").value);
      }
      const del = e.target.closest("[data-ct-borrar]");
      if (del) {
        const a = lista.find((x) => x.id === Number(del.dataset.ctBorrar));
        if (!confirm(`¿Borrar "${a.nombre}" de tus alimentos? Las comidas ya registradas no cambian.`)) return;
        const r = await db.from("alimentos").delete().eq("id", a.id);
        if (r.error) return avisar(errorLegible(r.error));
        lista.splice(lista.indexOf(a), 1); pintar($("ct-buscar").value); return;
      }
      const g = e.target.closest("[data-ct-gramos]");
      if (g) {
        const a = lista.find((x) => x.id === Number(g.dataset.ctGramos));
        const por100 = Object.fromEntries(NKEYS.map((k) => [k, (Number(a[k]) || 0) * 100 / Number(a.gramos)]));
        return hojaCantidad({ fuente: "catalogo", alimento_id: a.id, veces_usado: a.veces_usado, nombre: a.nombre, por100,
          porcion: { desc: a.porcion, gramos: Number(a.gramos) } }, agregar);
      }
      const b = e.target.closest("[data-ct-add]"); if (!b) return;
      const a = lista.find((x) => x.id === Number(b.dataset.ctAdd));
      const k = Number(document.querySelector(`[data-ct-cant="${a.id}"]`).value || 1);
      agregar({ alimento_id: a.id, nombre: a.nombre, cantidad: k, unidad: a.porcion, fuente: "catalogo", gramos: a.gramos ? r1(a.gramos * k) : null,
        ...Object.fromEntries(NKEYS.map((n) => [n, (Number(a[n]) || 0) * k])) });
      db.from("alimentos").update({ veces_usado: (a.veces_usado || 0) + 1, ultimo_uso: new Date().toISOString() }).eq("id", a.id);
      cerrarHoja(); avisar(`${a.nombre} añadido.`, "ok");
    });
  }

  // ---------- Comida saltada y cierre del día
  function hojaSaltada() {
    let cat = null;
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">Comida saltada</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">No necesita foto.</p>
      <div class="chips" id="sl-cat">${CATEGORIAS.map(([k, e, n]) => `<button type="button" data-sl="${k}" aria-pressed="false">${e} ${n}</button>`).join("")}</div>
      <button type="button" class="boton-principal" id="sl-ok" style="margin-top:16px">Registrar</button>`);
    $("sl-cat").addEventListener("click", (e) => { const b = e.target.closest("[data-sl]"); if (!b) return; cat = b.dataset.sl; $("sl-cat").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); });
    $("sl-ok").addEventListener("click", async () => {
      if (!cat) return avisar("Elige qué comida saltaste.");
      const ahora = new Date();
      const r = await db.from("comidas").insert({ user_id: usuario.id, fecha: comidaFecha, categoria: cat, saltada: true, estado: "completa",
        hora: String(ahora.getHours()).padStart(2, "0") + ":" + String(ahora.getMinutes()).padStart(2, "0") });
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja(); avisar("Comida saltada registrada.", "ok"); vistaComida();
    });
  }

  async function hojaCerrarDia() {
    const { data: d } = await db.rpc("resumen_dia_comida", { p_user: usuario.id, p_fecha: comidaFecha });
    const comidas = (d?.comidas || []).filter((c) => c.estado === "completa");
    const sinConfirmar = (d?.comidas || []).filter((c) => c.estado === "preparada");
    const mensaje = d?.comidas_min
      ? `¿Seguro que estas fueron todas tus comidas de hoy, y cada una tiene su foto? Registrar comidas que no hiciste suma puntos falsos y le quita sentido al desafío. Juega limpio. 💙`
      : `¿Seguro que estas fueron todas tus comidas de hoy? training.us funciona porque los dos confían en lo que registran. Omitir una comida para cuidar tus puntos rompe esa confianza y le quita sentido al desafío. 💗`;
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">Cerrar mi día</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <div class="lista" style="margin-bottom:14px">${comidas.length ? comidas.map((c) => `<p class="ayuda" style="margin:0">${CAT[c.categoria].emoji} ${c.saltada ? CAT[c.categoria].nombre + " saltado" : esc(c.nombre)}</p>`).join("") : `<p class="aviso">No registraste comidas hoy: el día contará como 0 %.</p>`}</div>
      ${sinConfirmar.length ? `<p class="aviso">📦 Tienes ${sinConfirmar.length} comida(s) preparada(s) sin confirmar: confírmala(s) o elimínala(s) antes de cerrar.</p>` : ""}
      <p class="aviso">${mensaje}</p>
      <button type="button" class="boton-principal" id="cd-ok" style="margin-top:14px">Sí, son todas</button>
      <button type="button" class="secundario" data-cerrar-hoja>Todavía me falta registrar algo</button>`);
    $("cd-ok").addEventListener("click", async () => {
      const r = await db.rpc("cerrar_dia_comida", { p_fecha: comidaFecha });
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja(); avisar("Día cerrado. ¡Gracias por registrar todo! ✨", "ok"); vistaComida();
    });
  }

  // Borra del almacenamiento mis fotos de comida que ya cumplieron 24 horas
  async function limpiarFotosComida() {
    const { data } = await db.from("comidas").select("id, foto_ruta").eq("user_id", usuario.id).eq("foto_borrada", false)
      .not("foto_ruta", "is", null).lt("foto_hasta", new Date().toISOString()).limit(60);
    if (!data?.length) return;
    const del = await db.storage.from("comidas").remove(data.map((c) => c.foto_ruta));
    if (!del.error) await db.rpc("marcar_fotos_comida_borradas", { p_ids: data.map((c) => c.id) });
  }

  async function accionesComida(e) {
    const t = e.target;
    const dia = t.closest("[data-dia-comida]");
    if (dia) { comidaFecha = sumarDias(comidaFecha, Number(dia.dataset.diaComida)); if (comidaFecha > yo().hoy) comidaFecha = yo().hoy; return vistaComida(); }
    const de = t.closest("[data-comida-de]");
    if (de) { comidaDe = de.dataset.comidaDe; return vistaComida(); }
    const ac = t.closest("[data-accion-comida]");
    if (ac) {
      const a = ac.dataset.accionComida;
      if (a === "nueva") return vistaFormComida(null);
      if (a === "saltada") return hojaSaltada();
      if (a === "cerrar") return hojaCerrarDia();
      if (a === "que-comer") return hojaQueComer();
      if (a === "volver") return irA("comida");
    }
    const it = t.closest("[data-comida]");
    if (it) return verComida(Number(it.dataset.comida));
    const cp = t.closest("[data-copiar-comida]");
    if (cp) { cerrarHoja(); comidaFecha = yo().hoy; return vistaFormComida(null, Number(cp.dataset.copiarComida)); }
    const ed = t.closest("[data-editar-comida]");
    if (ed) { cerrarHoja(); return vistaFormComida(Number(ed.dataset.editarComida)); }
    const bo = t.closest("[data-borrar-comida]");
    if (bo) {
      if (!confirm("¿Eliminar esta comida?")) return;
      const id = Number(bo.dataset.borrarComida);
      const { data: c } = await db.from("comidas").select("foto_ruta").eq("id", id).single();
      const r = await db.from("comidas").delete().eq("id", id);
      if (r.error) return avisar(errorLegible(r.error));
      if (c?.foto_ruta) db.storage.from("comidas").remove([c.foto_ruta]);
      cerrarHoja(); avisar("Comida eliminada.", "ok"); return vistaComida();
    }
    const ps = t.closest("[data-prep-si]");
    if (ps) {
      const id = Number(ps.dataset.prepSi);
      const r = await db.from("comidas").update({ estado: "completa", hora: ahoraHHMM(), foto_hasta: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }).eq("id", id);
      if (r.error) return avisar(errorLegible(r.error));
      avisar("¡Confirmada! 🍽️", "ok"); vistaComida(); comentarComida(id, comidaFecha); return;
    }
    const pn = t.closest("[data-prep-no]");
    if (pn) {
      if (!confirm("¿Eliminar esta comida preparada? No contará en tu día.")) return;
      const { data: c } = await db.from("comidas").select("foto_ruta").eq("id", Number(pn.dataset.prepNo)).single();
      await db.from("comidas").delete().eq("id", Number(pn.dataset.prepNo));
      if (c?.foto_ruta) db.storage.from("comidas").remove([c.foto_ruta]);
      return vistaComida();
    }
    const ag = t.closest("[data-agua]");
    if (ag) {
      if (ag.dataset.agua === "deshacer") {
        const { data } = await db.from("agua").select("id").eq("user_id", usuario.id).eq("fecha", comidaFecha).order("creado_en", { ascending: false }).limit(1);
        if (data?.[0]) await db.from("agua").delete().eq("id", data[0].id);
      } else {
        const r = await db.from("agua").insert({ user_id: usuario.id, fecha: comidaFecha, ml: Number(ag.dataset.agua) });
        if (r.error) return avisar(errorLegible(r.error));
      }
      return vistaComida();
    }
    const cj = t.closest("[data-comida-juntos]");
    if (cj) {
      cj.disabled = true;
      const r = await db.rpc("responder_comida_juntos", { p_id: Number(cj.dataset.id), p_acepta: cj.dataset.comidaJuntos === "si" });
      if (r.error) { cj.disabled = false; return avisar(errorLegible(r.error)); }
      avisar(r.data === "confirmado" ? "Confirmado: comieron juntos. 💞" : "Anotado.", "ok"); cerrarHoja(); return vistaComida();
    }
  }
  $("vista").addEventListener("click", accionesComida);
  $("hoja").addEventListener("click", accionesComida);

  // ================================================================ MÁS (fase 8)
  function vistaMas() {
    vistaActual = "mas";
    $("vista").innerHTML = `
      <h2 class="titulo">Más</h2>
      <div class="lista">
        ${[["estadisticas", "📊", "Estadísticas"], ["metas", "🎯", "Metas y retos"], ["coach", "🤖", "Coach"], ["aprende", "📚", "Aprende"], ["multas", "💰", "Multas y pagos"], ["recompensas", "🎁", "Recompensas"], ["mensajes", "💬", "Mensajes"],
           ["ausencias", "📝", "Ausencias y cupos"], ["exportar", "📤", "Exportar datos y reporte"], ["perfil", "👤", "Perfil y notificaciones"]].map(([v, e, n]) => `
          <button type="button" class="item" data-ir="${v}" style="min-height:64px"><span class="mini">${e}</span><span><strong>${n}</strong></span><span class="lado">›</span></button>`).join("")}
      </div>`;
  }
  $("vista").addEventListener("click", (e) => { const b = e.target.closest("[data-ir]"); if (b) irA(b.dataset.ir); });

  // ================================================================ ALIMENTOS, ESCÁNER E IA (fase 9)
  async function llamarCoach(cuerpo) {
    const { data, error } = await db.functions.invoke("coach", { body: { fecha: comidaFecha || yo()?.hoy, ...cuerpo } });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch (_) { /* sin detalle */ }
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }
  const FUENTE = { usda: "USDA", off: "Open Food Facts", catalogo: "Mis alimentos", manual: "Manual", ia: "Estimado por IA" };
  const MICRO = [["grasa_sat", "Grasa saturada", "g"], ["sodio_mg", "Sodio", "mg"], ["potasio_mg", "Potasio", "mg"],
    ["calcio_mg", "Calcio", "mg"], ["hierro_mg", "Hierro", "mg"], ["vit_c_mg", "Vitamina C", "mg"], ["vit_d_ug", "Vitamina D", "µg"]];
  const NKEYS = ["kcal", "proteina", "carbohidratos", "azucares", "grasas", "fibra", ...MICRO.map((m) => m[0])];
  const escalar = (por100, gramos) => Object.fromEntries(NKEYS.map((k) => [k, r1((Number(por100?.[k]) || 0) * gramos / 100)]));
  const resumenNutr = (n) => `${Math.round(n.kcal || 0)} kcal · P ${r1(n.proteina)} · C ${r1(n.carbohidratos)} · Az ${r1(n.azucares)} · G ${r1(n.grasas)} · F ${r1(n.fibra)}`;

  // Cantidad en gramos o porciones para un alimento con valores por 100 g
  function hojaCantidad(al, agregar) {
    const porcionG = al.porcion?.gramos || null;
    let modo = porcionG && al.fuente === "catalogo" ? "porciones" : "gramos";
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.4rem">${esc(al.nombre)}</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">${al.marca ? esc(al.marca) + " · " : ""}${FUENTE[al.fuente] || ""} · por 100 g: ${resumenNutr(al.por100)}</p>
      ${porcionG ? `<div class="segmentado" id="cq-modo"><button type="button" data-cq="gramos" aria-pressed="${modo === "gramos"}">Gramos</button>
        <button type="button" data-cq="porciones" aria-pressed="${modo === "porciones"}">Porciones (${esc(al.porcion.desc)})</button></div>` : ""}
      <div class="campo"><label for="cq-valor" id="cq-etq">${modo === "gramos" ? "Gramos" : "Porciones"}</label>
        <input id="cq-valor" type="number" inputmode="decimal" min="0" step="any" value="${modo === "gramos" ? 100 : 1}"></div>
      <p class="kcal" id="cq-prev"></p>
      ${al.fuente !== "catalogo" ? `<label class="interruptor" style="margin-top:12px"><span>Guardar en mis alimentos</span><input id="cq-guardar" type="checkbox" checked></label>` : ""}
      <button type="button" class="boton-principal" id="cq-ok" style="margin-top:14px">Añadir</button>`);
    const vacio = !al.por100?.kcal && !al.por100?.proteina && !al.por100?.carbohidratos && !al.por100?.grasas;
    if (vacio) {
      $("cq-ok").insertAdjacentHTML("beforebegin", `<p class="aviso">Este alimento no tiene datos nutricionales. Mejor lee la etiqueta o escribe los valores.</p>`);
      if ($("cq-guardar")) $("cq-guardar").checked = false;
    }
    const gramos = () => { const v = Number($("cq-valor").value || 0); return modo === "gramos" ? v : v * porcionG; };
    const prev = () => { $("cq-prev").textContent = `${r1(gramos())} g → ${resumenNutr(escalar(al.por100, gramos()))}`; };
    prev();
    $("cq-valor").addEventListener("input", prev);
    $("cq-modo")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-cq]"); if (!b) return;
      modo = b.dataset.cq;
      $("cq-modo").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
      $("cq-etq").textContent = modo === "gramos" ? "Gramos" : "Porciones";
      $("cq-valor").value = modo === "gramos" ? Math.round(porcionG) : 1; prev();
    });
    $("cq-ok").addEventListener("click", async () => {
      const g = gramos();
      if (!(g > 0)) return avisar("Escribe una cantidad.");
      let alimento_id = al.alimento_id || null;
      if ($("cq-guardar")?.checked) {
        const r = await db.from("alimentos").upsert({
          user_id: usuario.id, nombre: al.nombre.slice(0, 120), porcion: porcionG ? al.porcion.desc.slice(0, 40) : "100 g",
          gramos: porcionG || 100, fuente: al.fuente, codigo_barras: al.codigo || (al.fuente === "off" ? al.id : null),
          ...(porcionG ? escalar(al.por100, porcionG) : escalar(al.por100, 100))
        }, { onConflict: "user_id,nombre,porcion" }).select("id").single();
        if (!r.error && r.data) alimento_id = r.data.id;
      }
      if (al.fuente === "catalogo" && al.alimento_id) db.from("alimentos").update({ veces_usado: (al.veces_usado || 0) + 1, ultimo_uso: new Date().toISOString() }).eq("id", al.alimento_id);
      agregar({
        alimento_id, nombre: al.nombre.slice(0, 120), gramos: r1(g),
        cantidad: modo === "porciones" ? Number($("cq-valor").value) : r1(g), unidad: modo === "porciones" ? al.porcion.desc : "g",
        fuente: al.fuente, ...escalar(al.por100, g)
      });
      cerrarHoja(); avisar(`${al.nombre} añadido.`, "ok");
    });
  }

  // Búsqueda en USDA y Open Food Facts
  function hojaBuscar(agregar) {
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">Buscar alimento</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <div class="escribir" style="position:static;grid-template-columns:minmax(0,1fr) 92px">
        <input id="bs-q" type="search" placeholder="Ej.: pechuga de pollo, avena…" enterkeyhint="search">
        <button type="button" id="bs-ir" style="width:auto">Buscar</button>
      </div>
      <p class="ayuda">Para alimentos sin marca (pollo, arroz, avena, fruta) usa los genéricos; para productos empaquetados, mejor escanea el código.</p>
      <div class="lista" id="bs-res" style="margin-top:12px"></div>`);
    let resultados = [];
    const fila = (a, i) => `
          <button type="button" class="item" data-bs="${i}" style="grid-template-columns:minmax(0,1fr) auto;min-height:0">
            <span><strong>${esc(a.nombre)}</strong><span class="meta">${a.marca ? esc(a.marca) + " · " : ""}${Math.round(a.por100.kcal)} kcal · P ${r1(a.por100.proteina)} · C ${r1(a.por100.carbohidratos)} · G ${r1(a.por100.grasas)} <small>(100 g)</small></span></span>
            <span class="lado">›</span></button>`;
    const buscar = async () => {
      const q = $("bs-q").value.trim(); if (!q) return;
      $("bs-res").innerHTML = `<p class="vacio">Buscando…</p>`;
      try {
        const d = await llamarCoach({ accion: "buscar", consulta: q });
        const gen = d.genericos || [], mar = d.marcas || [];
        resultados = [...gen, ...mar];
        let html = (d.avisos || []).map((a) => `<p class="aviso">${esc(a)}</p>`).join("");
        if (gen.length) html += `<span class="grupo-titulo" style="margin-top:6px">🥦 Alimentos genéricos (USDA)</span>` + gen.map((a, i) => fila(a, i)).join("");
        if (mar.length) html += `<span class="grupo-titulo" style="margin-top:14px">🏷️ Productos de marca (Open Food Facts)</span>` + mar.map((a, i) => fila(a, gen.length + i)).join("");
        if (!resultados.length) html += `<p class="vacio">Sin resultados. Prueba con otras palabras, escanea el código o lee la etiqueta.</p>`;
        $("bs-res").innerHTML = html;
      } catch (err) { $("bs-res").innerHTML = ""; avisar(errorLegible(err)); }
    };
    $("bs-ir").addEventListener("click", buscar);
    $("bs-q").addEventListener("keydown", (e) => { if (e.key === "Enter") buscar(); });
    $("bs-res").addEventListener("click", (e) => { const b = e.target.closest("[data-bs]"); if (b) hojaCantidad(resultados[Number(b.dataset.bs)], agregar); });
    setTimeout(() => $("bs-q").focus(), 300);
  }

  // Escáner de códigos de barras (cámara, o foto del código como alternativa)
  let lectorActivo = null;
  function cargarLibreriaLector() {
    if (window.Html5Qrcode) return Promise.resolve();
    return new Promise((ok, mal) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js";
      s.onload = ok; s.onerror = () => mal(new Error("No se pudo cargar el lector de códigos."));
      document.head.appendChild(s);
    });
  }
  async function detenerLector() {
    if (lectorActivo) { try { await lectorActivo.stop(); } catch (_) { /* ya detenido */ } lectorActivo = null; }
  }
  async function hojaEscanear(agregar) {
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">Escanear código</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub" id="es-estado">Abriendo la cámara…</p>
      <div id="es-lector" class="lector"></div>
      <div class="acciones-juntos" style="margin-top:12px">
        <label class="secundario boton-archivo"><input type="file" accept="image/*" id="es-foto">📷 Foto del código</label>
        <button type="button" class="secundario" style="margin:0" id="es-manual">Escribir número</button>
      </div>`);
    const formatos = () => [Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8, Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E];
    const encontrado = async (codigo) => {
      await detenerLector();
      $("es-estado").textContent = `Código ${codigo}: buscando…`;
      try {
        const { producto } = await llamarCoach({ accion: "codigo", codigo });
        if (producto && !producto.incompleto) return hojaCantidad(producto, agregar);
        if (producto?.incompleto) return hojaSinDatos(producto.nombre, codigo, agregar);
        $("es-estado").textContent = `No encontramos el código ${codigo}. Escribe los valores de la etiqueta y quedará guardado para la próxima vez.`;
        hojaManual(agregar, codigo);
      } catch (err) { avisar(errorLegible(err)); }
    };
    try {
      await cargarLibreriaLector();
      lectorActivo = new Html5Qrcode("es-lector", { formatsToSupport: formatos(), verbose: false });
      await lectorActivo.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 260, height: 130 }, aspectRatio: 1.6 }, (txt) => encontrado(txt));
      $("es-estado").textContent = "Apunta al código de barras del producto.";
    } catch (err) {
      lectorActivo = null;
      $("es-estado").textContent = "No se pudo usar la cámara en vivo. Toma una foto del código o escribe el número.";
    }
    $("es-foto").addEventListener("change", async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        await cargarLibreriaLector(); await detenerLector();
        const lector = new Html5Qrcode("es-lector", { formatsToSupport: formatos(), verbose: false });
        encontrado(await lector.scanFile(file, false));
      } catch (_) { $("es-estado").textContent = "No pude leer el código en la foto. Acércate más o escribe el número."; }
    });
    $("es-manual").addEventListener("click", () => {
      const c = prompt("Número del código de barras:");
      if (c && c.replace(/\D/g, "").length >= 8) encontrado(c.replace(/\D/g, ""));
    });
  }
  $("hoja").addEventListener("click", (e) => { if (e.target === $("hoja") || e.target.closest("[data-cerrar-hoja]")) detenerLector(); });

  function hojaSinDatos(nombre, codigo, agregar) {
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.4rem">${esc(nombre || "Producto")}</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="aviso">Encontré el producto (código ${esc(codigo)}), pero su ficha en Open Food Facts no tiene información nutricional. Lee la etiqueta una vez y quedará guardado con su código para la próxima.</p>
      <div class="botones-lista" style="margin-top:14px">
        ${perfil.coach_activo ? `<button type="button" class="boton-principal" id="sd-etiqueta">📄 Leer la etiqueta con IA</button>` : ""}
        <button type="button" class="secundario" id="sd-manual">✏️ Escribir los valores</button>
      </div>`);
    $("sd-etiqueta")?.addEventListener("click", () => hojaEtiqueta(agregar, { nombre, codigo }));
    $("sd-manual").addEventListener("click", () => hojaManual(agregar, codigo));
  }

  function hojaEtiqueta(agregar, base = {}) {
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.4rem">📄 Leer etiqueta</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">Toma una foto de la tabla de <strong>Información nutricional</strong>, de frente, cerca y bien iluminada.</p>
      ${!base.nombre ? `<div class="campo"><label for="et-nombre">Nombre del producto</label><input id="et-nombre" maxlength="120" placeholder="Ej.: Galletas Club Social"></div>` : ""}
      <label class="boton-archivo secundario" style="margin-top:6px"><input type="file" accept="image/*" id="et-foto">📷 Tomar foto de la etiqueta</label>
      <p class="sub" id="et-estado" style="margin-top:12px"></p>`);
    $("et-foto").addEventListener("change", async (e) => {
      const file = e.target.files[0]; if (!file) return;
      $("et-estado").textContent = "🤖 Leyendo la etiqueta…";
      try {
        const imagen = await aBase64(await comprimir(file, 1280, 0.8));
        const nombre = base.nombre || $("et-nombre")?.value.trim() || null;
        const { producto } = await llamarCoach({ accion: "etiqueta", imagen, nombre });
        hojaCantidad({ ...producto, fuente: "ia", codigo: base.codigo || null }, agregar);
        avisar("Etiqueta leída: revisa que los valores coincidan.", "ok");
      } catch (err) { $("et-estado").textContent = errorLegible(err); }
    });
  }

  // IA: estimar desde la foto o desde una descripción
  const aBase64 = (blob) => new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
  async function estimarFoto(foto, agregarVarios, boton) {
    if (!foto) return avisar("Primero toma o elige la foto de la comida.");
    boton.disabled = true; const t = boton.textContent; boton.textContent = "🤖 Analizando…";
    try {
      const imagen = await aBase64(await comprimir(foto, 768, 0.7));
      const { items } = await llamarCoach({ accion: "foto", imagen });
      if (!items?.length) return avisar("No identifiqué alimentos en la foto. Añádelos de otra forma.");
      agregarVarios(items.map((i) => ({ ...i, fuente: "ia", cantidad: i.gramos || 1, unidad: i.gramos ? "g" : null })));
      avisar("Alimentos estimados: revisa las cantidades antes de guardar.", "ok");
    } catch (err) { avisar(errorLegible(err)); }
    finally { boton.disabled = false; boton.textContent = t; }
  }
  function hojaDescribir(agregarVarios) {
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">Describir lo que comí</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">Ej.: "2 huevos revueltos, una tostada integral con aguacate y un café con leche".</p>
      <textarea id="ds-texto" maxlength="600"></textarea>
      <button type="button" class="boton-principal" id="ds-ok" style="margin-top:12px">🤖 Calcular</button>`);
    $("ds-ok").addEventListener("click", async (e) => {
      const texto = $("ds-texto").value.trim(); if (!texto) return avisar("Describe lo que comiste.");
      e.target.disabled = true; e.target.textContent = "🤖 Calculando…";
      try {
        const { items } = await llamarCoach({ accion: "texto", texto });
        if (!items?.length) { e.target.disabled = false; e.target.textContent = "🤖 Calcular"; return avisar("No pude identificar alimentos. Prueba a describirlo distinto."); }
        agregarVarios(items.map((i) => ({ ...i, fuente: "ia", cantidad: i.gramos || 1, unidad: i.gramos ? "g" : null })));
        cerrarHoja(); avisar("Alimentos estimados: revisa las cantidades antes de guardar.", "ok");
      } catch (err) { e.target.disabled = false; e.target.textContent = "🤖 Calcular"; avisar(errorLegible(err)); }
    });
  }

  // Coach: comentario de una comida recién guardada y "qué como ahora"
  async function comentarComida(comidaId, fecha) {
    if (!perfil.coach_activo) return;
    try {
      const { texto } = await llamarCoach({ accion: "comentario", comida_id: comidaId, fecha });
      if (texto && vistaActual === "comida" && $("hoja").hidden)
        abrirHoja(`<div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.4rem">🤖 Coach</h2><button type="button" data-cerrar-hoja>Cerrar</button></div><p class="coach-texto">${esc(texto)}</p>`);
    } catch (_) { /* el comentario es opcional */ }
  }
  async function hojaQueComer() {
    abrirHoja(`<div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.4rem">🤖 ¿Qué como ahora?</h2><button type="button" data-cerrar-hoja>Cerrar</button></div><p class="sub" id="qc">Pensando en tus metas de hoy…</p>`);
    try {
      const ahora = new Date();
      const { texto } = await llamarCoach({ accion: "que_comer", hora: ahora.toTimeString().slice(0, 5) });
      if ($("qc")) { $("qc").className = "coach-texto"; $("qc").textContent = texto; }
    } catch (err) { if ($("qc")) $("qc").textContent = errorLegible(err); }
  }

  // Chat con el coach
  const TEMAS_COACH = {
    general: { titulo: "🤖 Coach", volver: "mas", sub: "Orientación personalizada para tu objetivo. No es consejo médico.",
      rapidos: ["¿Qué entrenamiento me ayuda más con mi objetivo?", "¿Cómo llego a mi proteína de hoy?", "Dame ideas de snacks saludables", "¿Ya puedo subir de nivel?"] },
    episodio: { titulo: "📓 Coach · registro personal", volver: "habitos", sub: "Un espacio sin juicios para entender tus episodios y encontrar estrategias. No sustituye a un profesional.",
      rapidos: ["Quiero contarte lo que pasó", "¿Ves algún patrón en mis registros?", "¿Qué puedo hacer cuando siento que va a pasar?", "¿Cómo organizo mis comidas para que no me pase?"] },
    bienestar: { titulo: "💛 Coach · bienestar", volver: "habitos", sub: "Acompañamiento para tus hábitos de cuidado. No sustituye a tu profesional de salud mental.",
      rapidos: ["Hoy me cuesta empezar el día", "¿Qué hábito pequeño hago ahora?", "Me siento sin energía", "Ayúdame a planear un día tranquilo"] },
    lesion: { titulo: "🩹 Coach · lesiones y dolores", volver: "habitos", sub: "Cuidados, ajustes y ejercicios alternativos. No diagnostica: ante señales de alarma, consulta a un profesional.",
      rapidos: ["Me duele al entrenar, te cuento", "¿Qué ejercicios puedo hacer sin cargar la zona?", "¿Cómo vuelvo a entrenar después de una lesión?", "¿Cómo caliento para evitar dolores?"] }
  };
  let temaCoach = "general";
  async function vistaCoach(tema) {
    if (tema) temaCoach = tema;
    const T = TEMAS_COACH[temaCoach];
    vistaActual = "coach";
    document.querySelectorAll("#pestanas button").forEach((b) => { if (b.dataset.vista === "mas") b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    $("vista").innerHTML = `
      <div class="cabecera-vista"><h2 class="titulo" style="font-size:1.6rem">${T.titulo}</h2><button type="button" data-ir="${T.volver}">Volver</button></div>
      <p class="sub" id="co-uso">${T.sub}</p>
      ${perfil.coach_activo ? "" : `<p class="aviso">El coach está apagado. Actívalo en Más → Perfil.</p>`}
      <div id="co-chat" class="chat"><p class="vacio">Cargando…</p></div>
      <div class="chips rapidos">${T.rapidos
        .map((t) => `<button type="button" data-co-rapido="${esc(t)}">${t}</button>`).join("")}</div>
      <div class="escribir">
        <textarea id="co-texto" maxlength="1000" rows="1" placeholder="Pregúntale al coach…"></textarea>
        <button type="button" id="co-enviar" aria-label="Enviar">➤</button>
      </div>`;
    const pintar = async () => {
      const [{ data }, uso] = await Promise.all([
        db.from("coach_mensajes").select("*").eq("user_id", usuario.id).eq("tema", temaCoach).neq("texto", "").order("id", { ascending: false }).limit(40),
        db.rpc("uso_ia_mes")]);
      if (!$("co-chat")) return;
      $("co-chat").innerHTML = (data || []).length ? [...data].reverse().map((m) =>
        `<div class="msg ${m.rol === "user" ? "mio " + (perfil.tema || "rosa") : "suyo coach"}"><span>${esc(m.texto)}</span></div>`).join("")
        : `<p class="vacio">Pregúntale lo que quieras sobre tus entrenamientos, tu alimentación o tus metas.</p>`;
      if (uso.data != null) $("co-uso").textContent = `${T.sub} Uso de IA este mes: USD ${Number(uso.data).toFixed(2)} de 1.00.`;
      window.scrollTo(0, document.body.scrollHeight);
    };
    const enviar = async (texto) => {
      texto = (texto || "").trim(); if (!texto) return;
      $("co-texto").value = "";
      $("co-chat").insertAdjacentHTML("beforeend", `<div class="msg mio ${perfil.tema || "rosa"}"><span>${esc(texto)}</span></div><div class="msg suyo coach" id="co-pensando"><span>Pensando…</span></div>`);
      window.scrollTo(0, document.body.scrollHeight);
      try { await llamarCoach({ accion: "chat", texto, tema: temaCoach }); } catch (err) { avisar(errorLegible(err)); }
      pintar();
    };
    $("co-enviar").addEventListener("click", () => enviar($("co-texto").value));
    $("vista").querySelectorAll("[data-co-rapido]").forEach((b) => b.addEventListener("click", () => enviar(b.dataset.coRapido)));
    pintar();
  }

  // ================================================================ NUTRICIÓN AVANZADA (fase 9B)
  // ---------- Recetas
  async function vistaRecetas() {
    vistaActual = "recetas";
    $("vista").innerHTML = `<div class="cabecera-vista"><h2 class="titulo">🍲 Recetas</h2><button type="button" data-ir="comida">Volver</button></div><p class="sub">Cargando…</p>`;
    const { data, error } = await db.from("recetas").select("*").eq("user_id", usuario.id).order("actualizado_en", { ascending: false });
    if (error) return avisar(errorLegible(error) + ". ¿Ejecutaste fase9b.sql?");
    $("vista").innerHTML = `
      <div class="cabecera-vista"><h2 class="titulo">🍲 Recetas</h2><button type="button" data-ir="comida">Volver</button></div>
      <p class="sub">Combina ingredientes, divide en porciones y úsala como un alimento más desde <strong>📚 Mis alimentos</strong>.</p>
      <button type="button" class="boton-principal" data-receta="nueva">Nueva receta</button>
      <div class="lista" style="margin-top:14px">${(data || []).map((r) => {
        const tot = sumaItems(r.items);
        return `<button type="button" class="item" data-receta="${r.id}" style="grid-template-columns:minmax(0,1fr) auto;min-height:0">
          <span><strong>${esc(r.nombre)}</strong><span class="meta">${r1(r.porciones)} porciones · por porción: ${Math.round(tot.kcal / r.porciones)} kcal · P ${r1(tot.proteina / r.porciones)} g</span></span>
          <span class="lado">›</span></button>`;
      }).join("") || `<p class="vacio">Todavía no tienes recetas.</p>`}</div>`;
  }
  const sumaItems = (items) => Object.fromEntries(NKEYS.map((k) => [k, (items || []).reduce((a, i) => a + (Number(i[k]) || 0), 0)]));

  async function editorReceta(id) {
    vistaActual = "receta-editor";
    const r = id ? (await db.from("recetas").select("*").eq("id", id).single()).data : null;
    const st = { items: r?.items ? [...r.items] : [] };
    $("vista").innerHTML = `
      <div class="cabecera-vista"><h2 class="titulo">${r ? "Editar receta" : "Nueva receta"}</h2><button type="button" data-ir="recetas">Cancelar</button></div>
      <section class="tarjeta">
        <div class="campo"><label for="rc-nombre">Nombre</label><input id="rc-nombre" maxlength="120" value="${esc(r?.nombre || "")}" placeholder="Ej.: Overnight oats de cacao"></div>
        <div class="fila"><div><label for="rc-porciones">Porciones</label><input id="rc-porciones" type="number" inputmode="decimal" min="0.5" step="0.5" value="${r?.porciones ?? 2}"></div>
          <div><label for="rc-gramos">Peso total cocinado (g, opcional)</label><input id="rc-gramos" type="number" inputmode="decimal" min="0" value="${r?.gramos_total ?? ""}"></div></div>
        <p class="ayuda">Con el peso total podrás registrarla también en gramos.</p>
      </section>
      <section class="tarjeta">
        <h3>Ingredientes</h3>
        <div id="rc-items" class="lista" style="margin-top:12px"></div>
        <div class="botones-alimento">
          <button type="button" class="secundario" data-rc-add="buscar">🔎 Buscar</button>
          <button type="button" class="secundario" data-rc-add="escanear">📷 Escanear</button>
          <button type="button" class="secundario" data-rc-add="catalogo">📚 Mis alimentos</button>
          <button type="button" class="secundario" data-rc-add="manual">✏️ Escribir valores</button>
          ${perfil.coach_activo ? `<button type="button" class="secundario" data-rc-add="describir">🤖 Describir</button><button type="button" class="secundario" data-rc-add="etiqueta">📄 Etiqueta</button>` : ""}
        </div>
        <p class="kcal" id="rc-total"></p>
      </section>
      <section class="tarjeta"><div class="campo"><label for="rc-notas">Preparación o notas</label><textarea id="rc-notas" maxlength="1000">${esc(r?.notas || "")}</textarea></div></section>
      <button type="button" class="boton-principal" id="rc-guardar">Guardar receta</button>
      ${r ? `<button type="button" class="secundario" id="rc-borrar" style="color:var(--error)">Eliminar receta</button>` : ""}`;
    const pintar = () => {
      $("rc-items").innerHTML = st.items.map((i, n) => `
        <div class="item" style="grid-template-columns:minmax(0,1fr) auto;min-height:0">
          <span><strong>${esc(i.nombre)}</strong><span class="meta">${i.gramos ? r1(i.gramos) + " g · " : ""}${Math.round(i.kcal)} kcal · P ${r1(i.proteina)} · C ${r1(i.carbohidratos)} · G ${r1(i.grasas)}</span></span>
          <button type="button" class="enlace" data-rc-quitar="${n}" style="width:auto;margin:0">Quitar</button></div>`).join("") || `<p class="ayuda" style="margin:0">Añade los ingredientes de la receta completa.</p>`;
      const t = sumaItems(st.items), p = Number($("rc-porciones").value) || 1;
      $("rc-total").textContent = st.items.length ? `Por porción: ${Math.round(t.kcal / p)} kcal · P ${r1(t.proteina / p)} g · C ${r1(t.carbohidratos / p)} g · G ${r1(t.grasas / p)} g · F ${r1(t.fibra / p)} g` : "";
    };
    pintar();
    $("rc-porciones").addEventListener("input", pintar);
    $("rc-items").addEventListener("click", (e) => { const b = e.target.closest("[data-rc-quitar]"); if (b) { st.items.splice(Number(b.dataset.rcQuitar), 1); pintar(); } });
    const agregar = (it) => { st.items.push(it); pintar(); };
    const agregarVarios = (l) => { st.items.push(...l); pintar(); };
    $("vista").querySelectorAll("[data-rc-add]").forEach((b) => b.addEventListener("click", () => {
      const a = b.dataset.rcAdd;
      if (a === "buscar") return hojaBuscar(agregar);
      if (a === "escanear") return hojaEscanear(agregar);
      if (a === "catalogo") return hojaCatalogo(agregar);
      if (a === "describir") return hojaDescribir(agregarVarios);
      if (a === "etiqueta") return hojaEtiqueta(agregar);
      return hojaManual(agregar);
    }));
    $("rc-borrar")?.addEventListener("click", async () => {
      if (!confirm("¿Eliminar esta receta? También se quitará de Mis alimentos; las comidas registradas no cambian.")) return;
      if (r.alimento_id) await db.from("alimentos").delete().eq("id", r.alimento_id);
      await db.from("recetas").delete().eq("id", r.id);
      avisar("Receta eliminada.", "ok"); irA("recetas");
    });
    $("rc-guardar").addEventListener("click", async (e) => {
      const nombre = $("rc-nombre").value.trim(), porciones = Number($("rc-porciones").value), gt = Number($("rc-gramos").value) || null;
      if (!nombre) return avisar("Ponle un nombre a la receta.");
      if (!(porciones > 0)) return avisar("Indica cuántas porciones salen.");
      if (!st.items.length) return avisar("Añade al menos un ingrediente.");
      e.target.disabled = true;
      const t = sumaItems(st.items);
      const porPorcion = Object.fromEntries(NKEYS.map((k) => [k, r1(t[k] / porciones)]));
      const datosAlimento = { user_id: usuario.id, nombre: "🍲 " + nombre, porcion: "1 porción", gramos: gt ? r1(gt / porciones) : null, fuente: "receta", ...porPorcion };
      let alimentoId = r?.alimento_id || null;
      const ra = alimentoId
        ? await db.from("alimentos").update(datosAlimento).eq("id", alimentoId).select("id").single()
        : await db.from("alimentos").upsert(datosAlimento, { onConflict: "user_id,nombre,porcion" }).select("id").single();
      if (!ra.error && ra.data) alimentoId = ra.data.id;
      const datos = { user_id: usuario.id, nombre, porciones, gramos_total: gt, items: st.items, notas: $("rc-notas").value.trim() || null, alimento_id: alimentoId, actualizado_en: new Date().toISOString() };
      const rr = r ? await db.from("recetas").update(datos).eq("id", r.id) : await db.from("recetas").insert(datos);
      e.target.disabled = false;
      if (rr.error) return avisar(errorLegible(rr.error));
      avisar("Receta guardada. Ya está en Mis alimentos. 🍲", "ok"); irA("recetas");
    });
  }

  // ---------- Check-in semanal, peso y tendencia
  function graficoPeso(serie) {
    if (serie.length < 2) return `<p class="ayuda">El gráfico aparece con dos registros de peso o más.</p>`;
    const W = 320, H = 140, px = 26, py = 14;
    const vals = serie.flatMap((x) => [x.kg, x.tendencia]);
    const min = Math.min(...vals) - 0.3, max = Math.max(...vals) + 0.3;
    const t0 = aFecha(serie[0].fecha).getTime(), t1 = aFecha(serie[serie.length - 1].fecha).getTime() || t0 + 1;
    const X = (f) => px + ((aFecha(f).getTime() - t0) / Math.max(1, t1 - t0)) * (W - 2 * px);
    const Y = (v) => H - py - ((v - min) / (max - min)) * (H - 2 * py);
    return `<svg viewBox="0 0 ${W} ${H + 16}" class="grafico" role="img" aria-label="Peso y tendencia">
      ${serie.map((x) => `<circle cx="${X(x.fecha)}" cy="${Y(x.kg)}" r="3.5" fill="var(--texto-suave)" opacity=".45"/>`).join("")}
      <polyline fill="none" stroke="var(--acento)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${serie.map((x) => X(x.fecha) + "," + Y(x.tendencia)).join(" ")}"/>
      <text x="${px}" y="${H + 12}" font-size="10" fill="var(--texto-suave)">${fechaCorta(serie[0].fecha)}</text>
      <text x="${W - px}" y="${H + 12}" font-size="10" text-anchor="end" fill="var(--texto-suave)">${fechaCorta(serie[serie.length - 1].fecha)}</text>
    </svg><div class="leyenda"><span><i style="background:var(--texto-suave);opacity:.45"></i>Pesajes</span><span><i style="background:var(--acento)"></i>Tendencia</span></div>`;
  }

  async function vistaCheckin() {
    vistaActual = "checkin";
    $("vista").innerHTML = `<div class="cabecera-vista"><h2 class="titulo">📈 Check-in</h2><button type="button" data-ir="comida">Volver</button></div><p class="sub">Cargando…</p>`;
    const semana = yo().semana_actual;
    const [plan, pesos, ck] = await Promise.all([
      db.from("plan_energia").select("*").eq("user_id", usuario.id).maybeSingle(),
      db.rpc("pesos_tendencia", { p_dias: 90 }),
      db.from("checkins").select("*").eq("user_id", usuario.id).order("semana", { ascending: false }).limit(6)]);
    if (pesos.error) return avisar(errorLegible(pesos.error) + ". ¿Ejecutaste fase9b.sql?");
    const pl = plan.data || { direccion: "mantener", ritmo_pct: 0.5, actividad: 1.4 };
    const serie = pesos.data || [];
    const ult = serie[serie.length - 1];
    const actual = (ck.data || []).find((c) => c.semana === semana);
    const ACT = [[1.2, "Sedentaria"], [1.4, "Ligera"], [1.55, "Moderada"], [1.75, "Alta"]];
    $("vista").innerHTML = `
      <div class="cabecera-vista"><h2 class="titulo">📈 Check-in</h2><button type="button" data-ir="comida">Volver</button></div>
      <p class="sub">Cada semana la app estima tu gasto real (lo que comes frente a la tendencia de tu peso) y te <strong>propone</strong> tus calorías. Tú decides si las aceptas. Todo esto es privado.</p>
      <section class="tarjeta">
        <h3>⚖️ Peso</h3>
        <p>${ult ? `Último: <strong>${ult.kg} kg</strong> · tendencia <strong>${ult.tendencia} kg</strong>` : "Todavía no registraste tu peso."}</p>
        <div class="escribir" style="position:static;grid-template-columns:minmax(0,1fr) 110px;margin-top:12px">
          <input id="ck-peso" type="number" inputmode="decimal" min="30" max="300" step="0.1" placeholder="Peso de hoy (kg)">
          <button type="button" id="ck-guardar-peso" style="width:auto">Guardar</button>
        </div>
        <p class="ayuda">Para una tendencia fiable, pésate en condiciones parecidas (por ejemplo, al despertar), idealmente varias veces por semana.</p>
        ${graficoPeso(serie)}
      </section>
      <section class="tarjeta">
        <h3>🎯 Tu plan</h3>
        <span class="grupo-titulo" style="margin-top:12px">Dirección</span>
        <div class="opciones campo" id="ck-dir">
          ${[["perder", "Bajar"], ["mantener", "Mantener"], ["ganar", "Subir"]].map(([k, n]) => `<label><input type="radio" name="ck-dir" value="${k}" ${pl.direccion === k ? "checked" : ""}><span>${n}</span></label>`).join("")}
        </div>
        <div class="fila">
          <div><label for="ck-ritmo">Ritmo por semana</label><select id="ck-ritmo">${[0.25, 0.5, 0.75, 1].map((v) => `<option value="${v}" ${Number(pl.ritmo_pct) === v ? "selected" : ""}>${v} % del peso</option>`).join("")}</select></div>
          <div><label for="ck-act">Actividad diaria</label><select id="ck-act">${ACT.map(([v, n]) => `<option value="${v}" ${Number(pl.actividad) === v ? "selected" : ""}>${n}</option>`).join("")}</select></div>
        </div>
        <p class="ayuda">El ritmo máximo es 1 % por semana para bajar y 0.5 % para subir. La propuesta nunca baja del mínimo de seguridad.</p>
        <button type="button" class="secundario" id="ck-guardar-plan">Guardar plan</button>
      </section>
      <section class="tarjeta" id="ck-resultado">
        <h3>🗓️ Check-in de la semana del ${fechaCorta(semana)}</h3>
        ${actual ? htmlCheckin(actual) : `<p>Hazlo una vez por semana, idealmente el lunes. Usa tus días de comida <strong>cerrados</strong> de las últimas dos semanas.</p>
          <button type="button" class="boton-principal" id="ck-hacer" style="margin-top:12px">Hacer check-in</button>`}
      </section>
      ${(ck.data || []).filter((c) => c.semana !== semana).length ? `<details class="historial"><summary>Check-ins anteriores</summary>${(ck.data || []).filter((c) => c.semana !== semana).map((c) =>
        `<p class="ayuda">${fechaCorta(c.semana)}: gasto ${c.tdee} kcal · propuesta ${c.kcal_propuesta} kcal · ${c.estado}</p>`).join("")}</details>` : ""}`;

    $("ck-guardar-peso").addEventListener("click", async () => {
      const kg = Number($("ck-peso").value);
      if (!(kg >= 30 && kg <= 300)) return avisar("Escribe tu peso en kg.");
      const r = await db.from("mediciones").insert({ user_id: usuario.id, fecha: yo().hoy, peso_kg: kg });
      if (r.error) return avisar(errorLegible(r.error));
      avisar("Peso guardado. 🔒", "ok"); vistaCheckin();
    });
    $("ck-guardar-plan").addEventListener("click", async () => {
      const r = await db.from("plan_energia").upsert({ user_id: usuario.id, direccion: document.querySelector('input[name="ck-dir"]:checked')?.value || "mantener",
        ritmo_pct: Number($("ck-ritmo").value), actividad: Number($("ck-act").value), actualizado_en: new Date().toISOString() }, { onConflict: "user_id" });
      if (r.error) return avisar(errorLegible(r.error));
      avisar("Plan guardado.", "ok");
    });
    $("ck-hacer")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      const r = await db.rpc("generar_checkin");
      if (r.error) { e.target.disabled = false; return avisar(errorLegible(r.error)); }
      vistaCheckin();
    });
    $("ck-resultado").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-ck]"); if (!b) return;
      const r = await db.rpc("responder_checkin", { p_acepta: b.dataset.ck === "si" });
      if (r.error) return avisar(errorLegible(r.error));
      avisar(r.data === "aceptado" ? "Nuevas calorías aplicadas desde esta semana." : "Mantienes tus calorías actuales.", "ok"); vistaCheckin();
    });
  }
  function htmlCheckin(c) {
    const fuente = { datos: "tus datos reales", mixto: "tus datos y una fórmula", formula: "una fórmula (aún faltan datos)" }[c.tdee_fuente] || "";
    return `
      <div class="fila-stat" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)"><span>Gasto estimado</span><strong>${c.tdee} kcal</strong></div>
      <div class="fila-stat" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)"><span>Cambio de tendencia</span><strong>${c.cambio_semana_kg > 0 ? "+" : ""}${c.cambio_semana_kg} kg/semana</strong></div>
      <div class="fila-stat" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)"><span>Calorías actuales</span><strong>${c.kcal_actual ?? "—"}</strong></div>
      <div class="fila-stat" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)"><span>Propuesta</span><strong>${c.kcal_propuesta} kcal</strong></div>
      <p class="ayuda">Calculado con ${fuente} · ${c.dias_datos} día(s) de comida cerrados.</p>
      ${c.nota ? `<p class="aviso">${esc(c.nota)}</p>` : ""}
      ${c.estado === "propuesto" ? `<div class="acciones-juntos"><button type="button" data-ck="si">Aceptar</button><button type="button" class="secundario" style="margin:0" data-ck="no">Mantener las mías</button></div>`
        : `<p><strong>${c.estado === "aceptado" ? "✓ Aceptado" : "Rechazado: mantienes tus calorías"}</strong></p>`}`;
  }

  // ---------- Exportar datos y reporte del mes
  function aCSV(filas) {
    if (!filas.length) return "";
    const cols = Object.keys(filas[0]);
    const celda = (v) => { const t = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    return "\ufeff" + [cols.join(","), ...filas.map((f) => cols.map((c) => celda(f[c])).join(","))].join("\n");
  }
  async function descargar(nombre, contenido, tipo = "text/csv") {
    const archivo = new File([contenido], nombre, { type: tipo });
    if (navigator.canShare?.({ files: [archivo] })) {
      try { await navigator.share({ files: [archivo], title: nombre }); return; } catch (_) { /* cancelado */ }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(archivo); a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
  }
  function vistaExportar() {
    vistaActual = "exportar";
    const mes = yo().hoy.slice(0, 7) + "-01";
    $("vista").innerHTML = `
      <div class="cabecera-vista"><h2 class="titulo">📤 Exportar</h2><button type="button" data-ir="mas">Volver</button></div>
      <p class="sub">Tus datos son tuyos: descárgalos cuando quieras. Solo se exportan tus propios registros.</p>
      <section class="tarjeta"><h3>Datos (CSV para Excel o Numbers)</h3>
        <div class="botones-lista" style="margin-top:12px">
          <button type="button" class="secundario" data-exp="comidas">🍽️ Comidas y alimentos</button>
          <button type="button" class="secundario" data-exp="entrenos">🏋️ Entrenamientos</button>
          <button type="button" class="secundario" data-exp="pesos">⚖️ Peso</button>
          <button type="button" class="secundario" data-exp="agua">💧 Agua</button>
        </div></section>
      <section class="tarjeta"><h3>Reporte del mes (PDF)</h3>
        <label for="ex-mes">Mes</label><select id="ex-mes" class="campo">${[0, -1, -2].map((i) => sumarMeses(mes, i)).map((m) => `<option value="${m}">${nombreMes(m)}</option>`).join("")}</select>
        <button type="button" class="boton-principal" data-exp="reporte">Ver reporte</button>
        <p class="ayuda">En el reporte toca <strong>Imprimir / Guardar PDF</strong> y en el iPhone elige "Guardar en Archivos".</p></section>`;
  }
  async function exportar(tipo) {
    try {
      if (tipo === "comidas") {
        const { data } = await db.from("comidas").select("fecha, hora, categoria, nombre, saltada, saludable, es_libre, contexto, sentimiento, comida_items(nombre, gramos, cantidad, unidad, kcal, proteina, carbohidratos, azucares, grasas, fibra, grasa_sat, sodio_mg)")
          .eq("user_id", usuario.id).eq("estado", "completa").order("fecha");
        const filas = (data || []).flatMap((c) => (c.comida_items?.length ? c.comida_items : [{}]).map((i) => ({
          fecha: c.fecha, hora: c.hora, comida: c.categoria, nombre: c.nombre, saltada: c.saltada, saludable: c.saludable, libre: c.es_libre,
          contexto: c.contexto, sentimiento: c.sentimiento, alimento: i.nombre, gramos: i.gramos, kcal: i.kcal, proteina: i.proteina,
          carbohidratos: i.carbohidratos, azucares: i.azucares, grasas: i.grasas, fibra: i.fibra, grasa_saturada: i.grasa_sat, sodio_mg: i.sodio_mg })));
        return descargar("training-us-comidas.csv", aCSV(filas));
      }
      if (tipo === "entrenos") {
        const { data } = await db.from("entrenos").select("fecha, hora, tipo, tipo_otro, duracion_min, distancia_km, zonas, juntos, animo, animo_nota, recuperacion, notas")
          .eq("user_id", usuario.id).eq("estado", "completado").order("fecha");
        return descargar("training-us-entrenamientos.csv", aCSV(data || []));
      }
      if (tipo === "pesos") {
        const { data } = await db.rpc("pesos_tendencia", { p_dias: 3650 });
        return descargar("training-us-peso.csv", aCSV(data || []));
      }
      if (tipo === "agua") {
        const { data } = await db.from("agua").select("fecha, ml, creado_en").eq("user_id", usuario.id).order("fecha");
        return descargar("training-us-agua.csv", aCSV(data || []));
      }
      if (tipo === "reporte") return vistaReporte($("ex-mes").value);
    } catch (err) { avisar(errorLegible(err)); }
  }
  async function vistaReporte(mes) {
    vistaActual = "reporte";
    $("vista").innerHTML = `<p class="sub">Preparando el reporte…</p>`;
    const { data: r, error } = await db.rpc("reporte_mes", { p_mes: mes });
    if (error || !r) return avisar(errorLegible(error));
    const dias = r.dias || [];
    const conDatos = dias.filter((d) => d.comidas > 0);
    const prom = (k) => conDatos.length ? conDatos.reduce((a, d) => a + Number(d[k] || 0), 0) / conDatos.length : 0;
    const entrenos = dias.reduce((a, d) => a + d.entrenos, 0), minutos = dias.reduce((a, d) => a + Number(d.minutos), 0);
    $("vista").innerHTML = `
      <div class="cabecera-vista no-imprimir"><h2 class="titulo">Reporte</h2><button type="button" data-ir="exportar">Volver</button></div>
      <div class="reporte">
        <h2 class="titulo" style="font-size:1.6rem">training.us · ${esc(r.nombre || "")}</h2>
        <p class="sub">${nombreMes(mes)}</p>
        <section class="tarjeta">
          <div class="fila-stat"><span>Promedio diario (días con registro)</span><strong>${Math.round(prom("kcal"))} kcal</strong><strong>P ${r1(prom("proteina"))} g</strong></div>
          <div class="fila-stat"><span>Carbohidratos / grasas / fibra</span><strong>${r1(prom("carbohidratos"))} / ${r1(prom("grasas"))} g</strong><strong>F ${r1(prom("fibra"))} g</strong></div>
          <div class="fila-stat"><span>Alimentación saludable</span><strong>${r.saludable_mes?.pct == null ? "—" : Math.round(r.saludable_mes.pct) + " %"}</strong><strong>${conDatos.length} días</strong></div>
          <div class="fila-stat"><span>Entrenamientos válidos</span><strong>${entrenos}</strong><strong>${minutos} min</strong></div>
        </section>
        <div class="tabla-scroll"><table class="tabla-reporte">
          <thead><tr><th>Día</th><th>kcal</th><th>P</th><th>C</th><th>G</th><th>F</th><th>% sal.</th><th>Agua</th><th>Entr.</th></tr></thead>
          <tbody>${dias.map((d) => `<tr><td>${fmt(d.fecha, { day: "numeric", month: "short" })}</td><td>${Math.round(d.kcal)}</td><td>${r1(d.proteina)}</td>
            <td>${r1(d.carbohidratos)}</td><td>${r1(d.grasas)}</td><td>${r1(d.fibra)}</td><td>${d.pct == null ? "—" : Math.round(d.pct)}</td><td>${d.agua}</td><td>${d.entrenos}</td></tr>`).join("")}</tbody>
        </table></div>
        <p class="ayuda">Valores en gramos salvo calorías y agua (ml). Datos privados de ${esc(r.nombre || "")}.</p>
      </div>
      <button type="button" class="boton-principal no-imprimir" onclick="window.print()">Imprimir / Guardar PDF</button>`;
  }
  $("vista").addEventListener("click", (e) => {
    const b = e.target.closest("[data-exp]"); if (b) exportar(b.dataset.exp);
    const rc = e.target.closest("[data-receta]"); if (rc) editorReceta(rc.dataset.receta === "nueva" ? null : Number(rc.dataset.receta));
  });

  // ---------- Entrenamientos importados de Apple Salud (borradores por completar con evidencia)
  async function cargarImportados() {
    const cont = $("importados"); if (!cont) return;
    const { data } = await db.from("entrenos").select("*").eq("user_id", usuario.id).eq("origen", "salud").eq("estado", "borrador")
      .gte("fecha", sumarDias(yo().hoy, antesDelInicio() ? -7 : -1)).order("fecha", { ascending: false });
    if (!data?.length) { cont.innerHTML = ""; return; }
    cont.innerHTML = `<section class="tarjeta pendiente"><h3>📲 Importados de Apple Salud</h3>
      <p>Añade la foto de evidencia (por ejemplo, la captura de Strava o del reloj) para que cuenten. Plazo: hasta mañana a las 12:00.</p>
      <div class="lista" style="margin-top:10px">${data.map((e) => `
        <div class="item" style="grid-template-columns:minmax(0,1fr) auto;min-height:0">
          <span><strong>${TIPO[e.tipo].emoji} ${esc(nombreTipo(e))}</strong><span class="meta">${etiquetaFecha(e.fecha)}${e.hora ? " · " + e.hora.slice(0, 5) : ""} · ${esc(resumenEntreno(e))}${e.kcal_dispositivo ? ` · 🔒 ${e.kcal_dispositivo} kcal` : ""}</span></span>
          <span style="display:grid;gap:4px"><button type="button" data-completar="${e.id}" style="min-height:36px;font-size:.88rem;padding:0 12px">Completar</button>
            <button type="button" class="enlace" data-descartar="${e.id}" style="min-height:28px;font-size:.8rem;padding:0">Descartar</button></span>
        </div>`).join("")}</div></section>`;
  }
  function hojaCompletar(id) {
    const fotos = [];
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">Completar entrenamiento</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">Añade de 1 a 3 fotos de evidencia y, si quieres, cómo te sentiste.</p>
      <div class="fotos" id="cp-fotos"></div>
      <span class="grupo-titulo" style="margin-top:16px">¿Cómo te sientes? (opcional)</span>
      <div class="chips" id="cp-animo">${ANIMOS.map(([k, e, n]) => `<button type="button" data-animo="${k}" aria-pressed="false">${e} ${n}</button>`).join("")}</div>
      <button type="button" class="boton-principal" id="cp-ok" style="margin-top:16px">Completar</button>`);
    let animo = null;
    const pintar = () => {
      $("cp-fotos").innerHTML = fotos.map((x) => `<div class="foto" style="background-image:url('${x.url}')"></div>`).join("") +
        (fotos.length < 3 ? `<label class="agregar-foto"><input type="file" accept="image/*" multiple id="cp-archivo">📷<br>Agregar</label>` : "");
      $("cp-archivo")?.addEventListener("change", (e) => { for (const f of [...e.target.files].slice(0, 3 - fotos.length)) fotos.push({ file: f, url: URL.createObjectURL(f) }); pintar(); });
    };
    pintar();
    $("cp-animo").addEventListener("click", (e) => { const b = e.target.closest("[data-animo]"); if (!b) return; animo = animo === b.dataset.animo ? null : b.dataset.animo;
      $("cp-animo").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.animo === animo)); });
    $("cp-ok").addEventListener("click", async (ev) => {
      if (!fotos.length) return avisar("Agrega al menos una foto de evidencia.");
      ev.target.disabled = true;
      try {
        for (let i = 0; i < fotos.length; i++) {
          const base = `${usuario.id}/${id}/${Date.now()}-${i}`;
          const [g, m] = await Promise.all([comprimir(fotos[i].file, 1280, 0.72), comprimir(fotos[i].file, 360, 0.7)]);
          for (const [ruta, blob] of [[base + ".jpg", g], [base + "-mini.jpg", m]]) {
            const up = await db.storage.from("evidencias").upload(ruta, blob, { contentType: "image/jpeg" }); if (up.error) throw up.error;
          }
          const r = await db.from("evidencias").insert({ entreno_id: id, user_id: usuario.id, ruta: base + ".jpg", miniatura: base + "-mini.jpg" }); if (r.error) throw r.error;
        }
        const r2 = await db.from("entrenos").update({ estado: "completado", animo }).eq("id", id); if (r2.error) throw r2.error;
        cerrarHoja(); avisar("Entrenamiento completado. 💪", "ok"); await recargarEstado(); irA("entrenar");
      } catch (err) { ev.target.disabled = false; avisar(errorLegible(err)); }
    });
  }
  $("vista").addEventListener("click", async (e) => {
    const c = e.target.closest("[data-completar]"); if (c) return hojaCompletar(Number(c.dataset.completar));
    const d = e.target.closest("[data-descartar]");
    if (d && confirm("¿Descartar este entrenamiento importado? No contará.")) { await db.from("entrenos").delete().eq("id", Number(d.dataset.descartar)); cargarImportados(); }
  });

  // ================================================================ HÁBITOS: SALUD Y CUERPO (fase 10)
  const BEBIDAS = { cerveza: ["🍺", "Cerveza", 330, 140], vino: ["🍷", "Vino", 150, 125], destilado: ["🥃", "Destilado", 45, 100], coctel: ["🍹", "Cóctel", 200, 200], otro: ["🥂", "Otra", 150, 120] };
  const SINTOMAS = ["Cólicos", "Cansancio", "Hinchazón", "Dolor de cabeza", "Antojos", "Cambios de ánimo", "Sensibilidad", "Dolor de espalda"];
  const EMOCIONES = ["Ansiedad", "Estrés", "Tristeza", "Aburrimiento", "Soledad", "Enojo", "Cansancio", "Celebración", "Otra"];
  const SITUACIONES = ["Sola o solo en casa", "Después de trabajar o estudiar", "De noche", "Había comido poco antes", "Con otras personas", "Frente a una pantalla", "Otra"];
  let habitosDe = "yo";
  const hhmm = (t) => (t ? String(t).slice(0, 5) : "—");
  const marca = (ok) => (ok ? "✓" : "✗");
  const ahoraHHMM = () => { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };

  async function vistaHabitos() {
    vistaActual = "habitos";
    const y = yo(), p = pareja();
    const quien = habitosDe === "yo" ? y : p;
    $("vista").innerHTML = `
      <h2 class="titulo">Hábitos</h2>
      <div class="segmentado" role="group" aria-label="Ver hábitos de">
        <button type="button" data-hab-de="yo" aria-pressed="${habitosDe === "yo"}">Mis hábitos</button>
        <button type="button" data-hab-de="pareja" aria-pressed="${habitosDe === "pareja"}">${esc(p?.nombre || "Pareja")}</button>
      </div>
      <div id="hab"><p class="vacio">Cargando…</p></div>`;
    if (!quien) return;
    const hoy = quien.hoy, lunes = quien.semana_actual, hace7 = sumarDias(hoy, -7), mesIni = hoy.slice(0, 8) + "01";
    const esMio = habitosDe === "yo";
    const [noches, alc, cic, dol, pas, eps, med, fotos, tok, evAnoche] = await Promise.all([
      db.from("sueno").select("*").eq("user_id", quien.id).gte("fecha", sumarDias(hoy, -8)).order("fecha", { ascending: false }),
      db.from("alcohol").select("*").eq("user_id", quien.id).gte("fecha", lunes).order("fecha", { ascending: false }),
      db.from("ciclo").select("*").eq("user_id", quien.id).order("inicio", { ascending: false }).limit(3),
      db.from("dolores").select("*").eq("user_id", quien.id).gte("fecha", sumarDias(hoy, -30)).order("fecha", { ascending: false }).limit(5),
      db.from("pasos_diarios").select("*").eq("user_id", quien.id).gte("fecha", hace7).order("fecha", { ascending: false }),
      db.from("episodios").select("*").eq("user_id", quien.id).gte("fecha", sumarDias(hoy, -60)).order("fecha", { ascending: false }),
      esMio ? db.from("mediciones").select("*").eq("user_id", quien.id).order("fecha", { ascending: false }).limit(20) : db.from("mediciones").select("*").eq("user_id", quien.id).eq("compartido", true).order("fecha", { ascending: false }).limit(5),
      db.from("fotos_progreso").select("*").eq("user_id", quien.id).order("fecha", { ascending: false }).limit(12),
      esMio ? db.from("tokens_salud").select("ultimo_uso").eq("user_id", usuario.id).maybeSingle() : Promise.resolve({ data: null }),
      db.rpc("evaluar_sueno", { p_user: quien.id, p_fecha: sumarDias(hoy, -1) })
    ]);
    if (noches.error) { $("hab").innerHTML = ""; return avisar(errorLegible(noches.error) + ". ¿Ejecutaste fase10.sql?"); }
    if (vistaActual !== "habitos") return;
    const ev = evAnoche.data;
    const meta = quien.meta_mes;
    const bebidasSemana = (alc.data || []).reduce((a, x) => a + Number(x.cantidad), 0);
    const cicloAbierto = (cic.data || []).find((c) => !c.fin);
    const pasosHoy = (pas.data || []).find((x) => x.fecha === hoy)?.pasos;
    const epsSemana = (eps.data || []).filter((e) => e.fecha >= lunes).length;
    const epsMes = (eps.data || []).filter((e) => e.fecha >= mesIni).length;
    const pesos = (med.data || []).filter((m) => m.peso_kg && m.tipo === "peso");
    const inbodys = (med.data || []).filter((m) => m.tipo === "inbody");
    const borradores = esMio ? (await db.from("entrenos").select("id").eq("user_id", usuario.id).eq("origen", "salud").eq("estado", "borrador")).data || [] : [];
    const muestraCiclo = (esMio ? perfil.sexo === "femenino" : false) || (cic.data || []).length > 0;

    const [htmlBienestar, htmlMascota] = await Promise.all([esMio ? tarjetaBienestar() : "", tarjetaMascota(quien.id)]);
    if (vistaActual !== "habitos") return;
    $("hab").innerHTML = `
      ${htmlMascota}
      ${htmlBienestar}
      <section class="tarjeta">
        <div class="nutri-cab"><h3 style="margin:0">😴 Sueño</h3>${esMio ? `<button type="button" class="enlace" data-hab="sueno" style="width:auto;min-height:0;padding:0">+ Registrar</button>` : ""}</div>
        ${ev ? `<p>Anoche: <strong>${hhmm(ev.dormir)} → ${hhmm(ev.despertar)}</strong> · ${r1(ev.horas)} h ${ev.neutral ? "· 🎉 salida nocturna (neutral)" : ""}</p>
          ${ev.neutral ? "" : `<div class="chips" style="margin-top:8px">
            <span class="etiqueta ${ev.cumple_dormir ? "etiqueta-ok" : "etiqueta-aviso"}">${marca(ev.cumple_dormir)} Dormir${ev.objetivo_dormir ? " (" + hhmm(ev.objetivo_dormir) + ")" : ""}</span>
            <span class="etiqueta ${ev.cumple_despertar ? "etiqueta-ok" : "etiqueta-aviso"}">${marca(ev.cumple_despertar)} Despertar${ev.objetivo_despertar ? " (" + hhmm(ev.objetivo_despertar) + ")" : ""}</span>
            <span class="etiqueta ${ev.cumple_horas ? "etiqueta-ok" : "etiqueta-aviso"}">${marca(ev.cumple_horas)} Horas</span></div>`}`
          : `<p>${esMio ? "Todavía no registraste cómo dormiste anoche." : "Sin registro de anoche."}</p>`}
        ${(noches.data || []).length ? `<div class="semana-sueno">${(noches.data || []).slice(0, 7).reverse().map((n) => `<span><small>${fmt(n.fecha, { weekday: "narrow" })}</small><strong>${r1(n.horas)}</strong></span>`).join("")}</div>` : ""}
      </section>

      <section class="tarjeta">
        <div class="nutri-cab"><h3 style="margin:0">🍷 Alcohol</h3>${esMio ? `<button type="button" class="enlace" data-hab="alcohol" style="width:auto;min-height:0;padding:0">+ Registrar</button>` : ""}</div>
        <p>Esta semana: <strong>${r1(bebidasSemana)} bebida${bebidasSemana === 1 ? "" : "s"}</strong>${meta?.alcohol_bebidas_semana != null ? ` de ${meta.alcohol_bebidas_semana} ${bebidasSemana > meta.alcohol_bebidas_semana ? "⚠️" : "✓"}` : ""}</p>
        ${(alc.data || []).slice(0, 4).map((a) => `<p class="ayuda" style="margin:2px 0">${BEBIDAS[a.bebida][0]} ${etiquetaFecha(a.fecha)} · ${r1(a.cantidad)} × ${BEBIDAS[a.bebida][1].toLowerCase()}${esMio ? ` · ${a.kcal} kcal` : ""}${esMio ? ` <button type="button" class="enlace" data-borrar-alc="${a.id}" style="width:auto;min-height:0;padding:0 4px;display:inline">Borrar</button>` : ""}</p>`).join("")}
      </section>

      <section class="tarjeta">
        <div class="nutri-cab"><h3 style="margin:0">👣 Pasos</h3>${esMio ? `<button type="button" class="enlace" data-ir="salud" style="width:auto;min-height:0;padding:0">${tok.data ? "Apple Salud ✓" : "Conectar Apple Salud"}</button>` : ""}</div>
        <p>${pasosHoy != null ? `Hoy: <strong>${Number(pasosHoy).toLocaleString("es")}</strong> pasos` : "Sin pasos registrados hoy."}</p>
        ${(pas.data || []).length > 1 ? `<p class="ayuda">Promedio 7 días: ${Math.round((pas.data || []).reduce((a, x) => a + x.pasos, 0) / (pas.data || []).length).toLocaleString("es")} pasos. Los pasos no cuentan como entrenamiento.</p>` : ""}
        ${esMio && borradores.length ? `<p class="aviso">📲 Tienes ${borradores.length} entrenamiento${borradores.length === 1 ? "" : "s"} importado${borradores.length === 1 ? "" : "s"} de Apple Salud por completar con evidencia.</p>
          <button type="button" class="secundario" data-ir="entrenar">Completarlos en Entrenar</button>` : ""}
      </section>

      ${muestraCiclo ? `<section class="tarjeta">
        <div class="nutri-cab"><h3 style="margin:0">🌸 Ciclo</h3></div>
        <p>${cicloAbierto ? `En periodo · día <strong>${Math.round((aFecha(hoy) - aFecha(cicloAbierto.inicio)) / 864e5) + 1}</strong>${cicloAbierto.sintomas?.length ? " · " + cicloAbierto.sintomas.join(", ").toLowerCase() : ""}`
          : (cic.data || [])[0] ? `Último periodo: ${fechaCorta(cic.data[0].inicio)}${cic.data[0].fin ? " – " + fechaCorta(cic.data[0].fin) : ""}` : "Sin registros."}</p>
        ${esMio ? (cicloAbierto ? `<div class="acciones-juntos"><button type="button" class="secundario" style="margin:0" data-hab="ciclo-sintomas" data-id="${cicloAbierto.id}">Síntomas</button><button type="button" style="margin:0" data-hab="ciclo-fin" data-id="${cicloAbierto.id}">Terminó hoy</button></div>`
          : `<button type="button" class="secundario" data-hab="ciclo-inicio">Empezó mi periodo</button><p class="ayuda">${esc(pareja()?.nombre || "Tu pareja")} recibirá un aviso para estar más atento estos días.</p>`) : ""}
      </section>` : ""}

      <section class="tarjeta">
        <div class="nutri-cab"><h3 style="margin:0">🩹 Lesiones y dolores</h3>${esMio ? `<button type="button" class="enlace" data-hab="dolor" style="width:auto;min-height:0;padding:0">+ Registrar</button>` : ""}</div>
        ${(dol.data || []).length ? (dol.data || []).map((d) => `<p class="ayuda" style="margin:4px 0">${d.tipo === "lesion" ? "🩹" : "⚡"} ${etiquetaFecha(d.fecha)} · <strong>${esc(d.zona)}</strong> · intensidad ${d.intensidad}/10${d.momento ? " · " + esc(d.momento) : ""}</p>`).join("") : `<p>Sin dolores registrados en el último mes.</p>`}
        ${esMio ? `<div class="acciones-juntos" style="margin-top:10px"><button type="button" class="secundario" style="margin:0" data-hab="coach-lesion">🤖 Hablar con el coach</button><button type="button" class="secundario" style="margin:0" data-exc="lesion">Pausa y tratamientos</button></div>` : ""}
      </section>

      ${esMio ? `<section class="tarjeta">
        <div class="nutri-cab"><h3 style="margin:0">⚖️ Cuerpo</h3><span class="privado" style="margin:0">🔒 Privado</span></div>
        <p>${pesos[0] ? `Último peso: <strong>${pesos[0].peso_kg} kg</strong> (${fechaCorta(pesos[0].fecha)})` : "Sin pesos registrados."}</p>
        ${inbodys[0] ? `<p class="ayuda">Último InBody (${fechaCorta(inbodys[0].fecha)}): ${inbodys[0].grasa_pct != null ? inbodys[0].grasa_pct + " % grasa · " : ""}${inbodys[0].masa_muscular_kg != null ? inbodys[0].masa_muscular_kg + " kg músculo" : ""}${inbodys[0].compartido ? " · compartido" : ""}</p>` : ""}
        <div class="botones-alimento">
          <button type="button" class="secundario" data-ir="checkin">⚖️ Peso y tendencia</button>
          <button type="button" class="secundario" data-hab="inbody">📊 Registrar InBody</button>
          <button type="button" class="secundario" data-hab="foto">📸 Foto de progreso</button>
          <button type="button" class="secundario" data-hab="fotos" ${(fotos.data || []).length ? "" : "disabled"}>🖼️ Ver y comparar (${(fotos.data || []).length})</button>
        </div>
      </section>` : `${(fotos.data || []).length || (med.data || []).length ? `<section class="tarjeta"><h3>⚖️ Lo que comparte contigo</h3>
          ${(med.data || []).map((m) => `<p class="ayuda">${m.tipo === "inbody" ? "📊 InBody" : "⚖️ Peso"} · ${fechaCorta(m.fecha)}${m.peso_kg ? " · " + m.peso_kg + " kg" : ""}${m.grasa_pct != null ? " · " + m.grasa_pct + " % grasa" : ""}</p>`).join("")}
          ${(fotos.data || []).length ? `<button type="button" class="secundario" data-hab="fotos">🖼️ Ver fotos compartidas (${(fotos.data || []).length})</button>` : ""}</section>` : ""}`}

      ${esMio ? `<section class="tarjeta">
        <h3>📓 Registro personal</h3><p class="privado" style="margin:4px 0 0">🔒 Privado: tú decides qué compartir.</p>
        <p>Esta semana: <strong>${epsSemana}</strong> · este mes: <strong>${epsMes}</strong>. Es un espacio para entender patrones, sin castigos.</p>
        ${patronesEpisodios(eps.data || [])}
        <div class="acciones-juntos" style="margin-top:10px"><button type="button" class="secundario" style="margin:0" data-hab="episodio">Registrar un episodio</button>
          <button type="button" class="secundario" style="margin:0" data-hab="coach-episodio">🤖 Hablar con el coach</button></div>
      </section>` : (eps.data || []).length ? `<section class="tarjeta"><h3>📓 Lo que ${esc(quien.nombre)} decidió compartir</h3>
          ${(eps.data || []).slice(0, 5).map((e) => `<p class="ayuda">${etiquetaFecha(e.fecha)}${e.hora ? " · " + hhmm(e.hora) : ""}${e.emociones?.length ? " · " + e.emociones.join(", ").toLowerCase() : ""}${e.nota ? "<br>" + esc(e.nota) : ""}</p>`).join("")}
          <p class="ayuda">Acompáñale con cariño y sin juicios. 💗</p></section>` : ""}`;
  }

  // Patrones simples a partir de los episodios registrados
  function patronesEpisodios(eps) {
    if (eps.length < 2) return eps.length ? `<p class="ayuda">Con más registros verás aquí patrones de horario, situaciones y emociones.</p>` : "";
    const cuenta = (lista) => Object.entries(lista.reduce((a, k) => ((a[k] = (a[k] || 0) + 1), a), {})).sort((x, y) => y[1] - x[1]).slice(0, 3);
    const franja = (h) => { if (!h) return null; const n = Number(String(h).slice(0, 2)); return n < 12 ? "Mañana" : n < 17 ? "Tarde" : n < 21 ? "Noche" : "Muy tarde"; };
    const franjas = cuenta(eps.map((e) => franja(e.hora)).filter(Boolean));
    const emo = cuenta(eps.flatMap((e) => e.emociones || []));
    const sit = cuenta(eps.flatMap((e) => e.situacion || []));
    const fila = (t, l) => l.length ? `<p class="ayuda" style="margin:2px 0"><strong>${t}:</strong> ${l.map(([k, n]) => `${k.toLowerCase()} (${n})`).join(", ")}</p>` : "";
    return `<details class="historial"><summary>Patrones de los últimos 60 días</summary>${fila("Horario", franjas)}${fila("Emociones", emo)}${fila("Situaciones", sit)}
      <p class="ayuda">Son coincidencias en tus registros, no causas. Si quieres, coméntalas con el coach o con un profesional.</p></details>`;
  }

  // ---------- Bienestar: hábitos de cuidado y check-in de ánimo
  const NIVELES = [[1, "😞", "Muy mal"], [2, "😕", "Mal"], [3, "😐", "Regular"], [4, "🙂", "Bien"], [5, "😊", "Muy bien"]];
  const EMOCIONES_ANIMO = ["Tristeza", "Ansiedad", "Cansancio", "Apatía", "Soledad", "Irritabilidad", "Calma", "Motivación", "Alegría", "Gratitud"];
  const AYUDA_CRISIS = `Si sientes que no puedes con esto, o aparecen pensamientos de hacerte daño, busca ayuda ahora: tu psicóloga/o o psiquiatra, una persona de confianza, o emergencias (911 en Panamá · 112 en España · 024 en España).`;

  async function tarjetaBienestar() {
    let { data: est, error } = await db.rpc("estado_bienestar");
    if (error) return `<section class="tarjeta"><p class="ayuda">Para activar el plan de bienestar, ejecuta fase10-ampliacion.sql.</p></section>`;
    if (!est?.habitos?.length) return `
      <section class="tarjeta bienestar">
        <h3>💛 Bienestar</h3>
        <p>Un plan con tus hábitos de cuidado (dormir a tiempo, salir de casa, bañarte, vestirte, moverte, comer algo que te haga bien) y un check-in diario de ánimo. Si pasa más de un día sin uno de ellos, la app te lo recuerda con cariño.</p>
        <button type="button" class="boton-principal" data-bien="crear" style="margin-top:12px">Crear mi plan de bienestar</button>
        <p class="ayuda">Es privado: solo tú lo ves. Complementa, no sustituye, el acompañamiento profesional.</p>
      </section>`;
    const a = est.animo;
    const nivel = a ? NIVELES.find((n) => n[0] === a.nivel) : null;
    return `
      <section class="tarjeta bienestar">
        <div class="nutri-cab"><h3 style="margin:0">💛 Bienestar</h3><button type="button" class="enlace" data-bien="config" style="width:auto;min-height:0;padding:0">Editar plan</button></div>
        ${a ? `<p>Hoy: <strong>${nivel[1]} ${nivel[2]}</strong>${a.emociones?.length ? " · " + a.emociones.join(", ").toLowerCase() : ""} <button type="button" class="enlace" data-bien="animo" style="width:auto;min-height:0;padding:0 4px;display:inline">Cambiar</button></p>`
          : `<button type="button" class="boton-principal" data-bien="animo" style="margin-top:10px">¿Cómo te sientes hoy?</button>`}
        ${(est.animo_semana || []).length > 1 ? `<div class="semana-sueno">${est.animo_semana.map((x) => `<span><small>${fmt(x.fecha, { weekday: "narrow" })}</small><strong>${NIVELES[x.nivel - 1][1]}</strong></span>`).join("")}</div>` : ""}
        <div class="lista-bienestar">${est.habitos.map((h) => `
          <div class="habito ${h.hoy_ok ? "ok" : h.alerta ? "alerta" : ""}">
            <span class="habito-emoji">${h.emoji}</span>
            <span><strong>${esc(h.nombre)}</strong><span class="meta">${h.hoy_ok ? "✓ Cumplido" : h.unidad === "comidas" ? (h.sin ? `${h.sin} comida(s) seguidas sin` : "—") : h.sin > 0 ? `${h.sin} ${h.unidad === "noches" ? "noche(s)" : "día(s)"} sin cumplir` : "Pendiente hoy"}${h.alerta ? " · 💛 toca hoy" : ""}</span></span>
            ${h.tipo === "manual" ? `<button type="button" class="${h.hoy_ok ? "secundario" : ""}" data-bien-hecho="${esc(h.clave)}" data-v="${!h.hoy_ok}" style="width:auto;min-height:36px;padding:0 12px;font-size:.88rem;margin:0">${h.hoy_ok ? "Hecho ✓" : "Hecho hoy"}</button>`
              : `<span class="ayuda" style="margin:0;font-size:.75rem">auto</span>`}
          </div>`).join("")}</div>
        <p class="ayuda">Los de sueño, ejercicio y comida se actualizan solos con tus registros.</p>
        <button type="button" class="secundario" data-bien="coach">🤖 Hablar con el coach</button>
      </section>`;
  }

  function hojaAnimo() {
    let nivel = null;
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">💛 ¿Cómo te sientes hoy?</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <div class="niveles" id="an-nivel">${NIVELES.map(([n, e, t]) => `<button type="button" data-n="${n}" aria-pressed="false"><span>${e}</span>${t}</button>`).join("")}</div>
      <span class="grupo-titulo" style="margin-top:16px">¿Qué sientes? (opcional)</span>${chipsMulti("an-emo", EMOCIONES_ANIMO)}
      <div class="campo" style="margin-top:14px"><label for="an-nota">Lo que quieras contar (opcional)</label><textarea id="an-nota" maxlength="1000"></textarea></div>
      <label class="interruptor campo"><span>💗 Avisar a ${esc(pareja()?.nombre || "mi pareja")} que hoy necesito apoyo</span><input id="an-apoyo" type="checkbox"></label>
      <p class="ayuda" style="margin:-10px 0 14px">Solo le llega el aviso, sin detalles de lo que escribas.</p>
      <button type="button" class="boton-principal" id="an-ok">Guardar</button>`);
    activarChips("an-emo");
    $("an-nivel").addEventListener("click", (e) => {
      const b = e.target.closest("[data-n]"); if (!b) return;
      nivel = Number(b.dataset.n); $("an-nivel").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    });
    $("an-ok").addEventListener("click", async (e) => {
      if (!nivel) return avisar("Elige cómo te sientes.");
      e.target.disabled = true;
      const datos = { user_id: usuario.id, fecha: yo().hoy, nivel, emociones: leerChips("an-emo"), nota: $("an-nota").value.trim() || null, pedir_apoyo: $("an-apoyo").checked };
      const r = await db.from("animo_diario").upsert(datos, { onConflict: "user_id,fecha" });
      if (r.error) { e.target.disabled = false; return avisar(errorLegible(r.error)); }
      abrirHoja(`<div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.4rem">💛 Gracias por contarlo</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
        <p class="coach-texto" id="an-respuesta">${perfil.coach_activo ? "🤖 El coach está escribiéndote…" : "Registrado. Revisa tus hábitos de cuidado de hoy, paso a paso."}</p>
        ${nivel <= 2 ? `<p class="aviso" style="margin-top:14px">${AYUDA_CRISIS}</p>` : ""}`);
      vistaHabitos();
      if (perfil.coach_activo) {
        try { const { texto } = await llamarCoach({ accion: "bienestar", nivel, emociones: datos.emociones, nota: datos.nota }); if ($("an-respuesta") && texto) $("an-respuesta").textContent = texto; }
        catch (err) { if ($("an-respuesta")) $("an-respuesta").textContent = "Registrado. " + errorLegible(err); }
      }
    });
  }

  async function hojaPlanBienestar() {
    const { data } = await db.from("habitos_bienestar").select("*").eq("user_id", usuario.id).order("orden").order("id");
    const lista = data || [];
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">💛 Mi plan de bienestar</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">Activa los hábitos que te ayudan y elige cuánto tiempo puede pasar sin cumplirlos antes de que la app te lo recuerde.</p>
      <div class="lista" id="pb-lista">${lista.map((h) => `
        <div class="tarjeta" style="margin:0" data-pb="${h.id}">
          <label class="interruptor"><span>${h.emoji} ${esc(h.nombre)}</span><input type="checkbox" class="pb-activo" ${h.activo ? "checked" : ""}></label>
          <div class="fila" style="margin-top:10px">
            <div><label>Recordar después de</label><select class="pb-max">${[1, 2, 3].map((n) => `<option value="${n}" ${h.max_dias_sin === n ? "selected" : ""}>${n} ${h.tipo === "comida" ? "comida(s)" : h.tipo.startsWith("sueno") ? "noche(s)" : "día(s)"}</option>`).join("")}</select></div>
            ${h.tipo === "sueno_hora" ? `<div><label>Dormir antes de las</label><select class="pb-param">${[21, 22, 23].map((n) => `<option value="${n}" ${Number(h.parametro) === n ? "selected" : ""}>${n}:00</option>`).join("")}</select></div>`
              : h.tipo === "sueno_horas" ? `<div><label>Horas mínimas</label><select class="pb-param">${[6, 6.5, 7, 7.5, 8].map((n) => `<option value="${n}" ${Number(h.parametro) === n ? "selected" : ""}>${n} h</option>`).join("")}</select></div>` : "<div></div>"}
          </div>
          ${h.tipo === "manual" && !["salir_casa", "banarse", "vestirse"].includes(h.clave) ? `<button type="button" class="enlace" data-pb-borrar="${h.id}" style="color:var(--error);text-align:left;padding-left:0">Eliminar</button>` : ""}
        </div>`).join("")}</div>
      <section class="tarjeta" style="margin-top:14px"><h3>Añadir un hábito propio</h3>
        <div class="fila" style="margin-top:10px"><div><label for="pb-emoji">Emoji</label><input id="pb-emoji" maxlength="4" value="✨"></div><div><label for="pb-nombre">Hábito</label><input id="pb-nombre" maxlength="80" placeholder="Ej.: Hablar con una amiga"></div></div>
        <button type="button" class="secundario" id="pb-anadir">Añadir</button></section>
      <button type="button" class="boton-principal" id="pb-ok">Guardar plan</button>`);
    $("pb-anadir").addEventListener("click", async () => {
      const nombre = $("pb-nombre").value.trim(); if (!nombre) return avisar("Escribe el hábito.");
      const r = await db.from("habitos_bienestar").insert({ user_id: usuario.id, clave: "propio_" + Date.now(), nombre, emoji: $("pb-emoji").value.trim() || "✨", tipo: "manual", orden: 50 });
      if (r.error) return avisar(errorLegible(r.error));
      hojaPlanBienestar();
    });
    $("pb-lista").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-pb-borrar]"); if (!b) return;
      if (!confirm("¿Eliminar este hábito?")) return;
      await db.from("habitos_bienestar").delete().eq("id", Number(b.dataset.pbBorrar)); hojaPlanBienestar();
    });
    $("pb-ok").addEventListener("click", async () => {
      for (const t of document.querySelectorAll("[data-pb]")) {
        const cambios = { activo: t.querySelector(".pb-activo").checked, max_dias_sin: Number(t.querySelector(".pb-max").value) };
        if (t.querySelector(".pb-param")) cambios.parametro = Number(t.querySelector(".pb-param").value);
        await db.from("habitos_bienestar").update(cambios).eq("id", Number(t.dataset.pb));
      }
      cerrarHoja(); avisar("Plan guardado. 💛", "ok"); vistaHabitos();
    });
  }

  $("vista").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-bien]");
    if (b) {
      const a = b.dataset.bien;
      if (a === "crear") { const r = await db.rpc("crear_plan_bienestar"); if (r.error) return avisar(errorLegible(r.error)); avisar("Plan creado. Puedes ajustarlo cuando quieras. 💛", "ok"); return vistaHabitos(); }
      if (a === "animo") return hojaAnimo();
      if (a === "config") return hojaPlanBienestar();
      if (a === "coach") return vistaCoach("bienestar");
    }
    const h = e.target.closest("[data-bien-hecho]");
    if (h) {
      const hecho = h.dataset.v === "true";
      const r = hecho
        ? await db.from("bienestar_registros").upsert({ user_id: usuario.id, fecha: yo().hoy, clave: h.dataset.bienHecho, hecho: true }, { onConflict: "user_id,fecha,clave" })
        : await db.from("bienestar_registros").delete().eq("user_id", usuario.id).eq("fecha", yo().hoy).eq("clave", h.dataset.bienHecho);
      if (r.error) return avisar(errorLegible(r.error));
      if (hecho) avisar("¡Bien hecho! 💛", "ok");
      return vistaHabitos();
    }
  });

  // ---------- Hojas de registro
  function chipsMulti(id, opciones, sel = []) {
    return `<div class="chips" id="${id}">${opciones.map((o) => `<button type="button" data-v="${esc(o)}" aria-pressed="${sel.includes(o)}">${o}</button>`).join("")}</div>`;
  }
  const leerChips = (id) => [...document.querySelectorAll(`#${id} button[aria-pressed="true"]`)].map((b) => b.dataset.v);
  const activarChips = (id, unico = false) => $(id)?.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]"); if (!b) return;
    if (unico) $(id).querySelectorAll("button").forEach((x) => x !== b && x.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true");
  });

  async function hojaSueno() {
    const y = yo(), anoche = sumarDias(y.hoy, -1);
    const { data: ms } = await db.from("metas_semanales").select("*").eq("user_id", usuario.id).lte("semana", y.semana_actual).order("semana", { ascending: false }).limit(1);
    const m = ms?.[0];
    const objD = m ? (["5", "6"].includes(String(new Date(anoche + "T12:00:00Z").getUTCDay() === 0 ? 7 : new Date(anoche + "T12:00:00Z").getUTCDay())) ? m.dormir_finde : m.dormir_semana) : null;
    const { data: prev } = await db.from("sueno").select("*").eq("user_id", usuario.id).eq("fecha", anoche).maybeSingle();
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">😴 ¿Cómo dormiste?</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">Noche del ${nombreDia(anoche)}. Sin evidencia: confiamos en tu honestidad.</p>
      <div class="fila campo">
        <div><label for="sn-d">😴 Me dormí</label><input id="sn-d" type="time" value="${hhmm(prev?.dormir || objD || "23:00").replace("—", "23:00")}"></div>
        <div><label for="sn-w">⏰ Desperté</label><input id="sn-w" type="time" value="${prev?.despertar ? hhmm(prev.despertar) : "07:00"}"></div>
      </div>
      <p class="duracion" id="sn-dur"></p>
      <label class="interruptor campo" style="margin-top:12px"><span>🎉 Fue una salida nocturna</span><input id="sn-salida" type="checkbox" ${prev?.salida ? "checked" : ""}></label>
      <p class="ayuda" style="margin:-10px 0 14px">Solo es neutral los viernes, sábados o días especiales, con un máximo de 3 al mes.</p>
      <div class="campo"><label for="sn-notas">Notas (opcional)</label><textarea id="sn-notas" maxlength="500">${esc(prev?.notas || "")}</textarea></div>
      <button type="button" class="boton-principal" id="sn-ok">Guardar</button>`);
    const dur = () => { const d = duracion($("sn-d").value, $("sn-w").value); $("sn-dur").textContent = d ? "Total: " + textoDuracion(d) : ""; };
    dur(); $("sn-d").addEventListener("input", dur); $("sn-w").addEventListener("input", dur);
    $("sn-ok").addEventListener("click", async () => {
      const r = await db.from("sueno").upsert({ user_id: usuario.id, fecha: anoche, dormir: $("sn-d").value, despertar: $("sn-w").value,
        salida: $("sn-salida").checked, notas: $("sn-notas").value.trim() || null }, { onConflict: "user_id,fecha" }).select("salida, salida_neutral").single();
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja();
      avisar(r.data?.salida && !r.data.salida_neutral ? "Guardado. Esa salida no cuenta como neutral (día no permitido o sin saldo)." : "Sueño registrado. 😴", "ok");
      vistaHabitos();
    });
  }

  function hojaAlcohol() {
    let bebida = "cerveza";
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">🍷 Registrar bebida</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <div class="tipos" id="al-tipo" style="margin-bottom:14px">${Object.entries(BEBIDAS).map(([k, [e, n]]) => `<button type="button" data-al="${k}" aria-pressed="${k === bebida}"><span>${e}</span>${n}</button>`).join("")}</div>
      <div class="fila campo">
        <div><label for="al-cant">Cantidad (bebidas)</label><input id="al-cant" type="number" inputmode="decimal" min="0.5" step="0.5" value="1"></div>
        <div><label for="al-ml">ml por bebida</label><input id="al-ml" type="number" inputmode="numeric" min="1" value="${BEBIDAS[bebida][2]}"></div>
      </div>
      <div class="fila campo">
        <div><label for="al-fecha">Día</label><select id="al-fecha"><option value="${yo().hoy}">Hoy</option><option value="${sumarDias(yo().hoy, -1)}">Ayer</option></select></div>
        <div><label for="al-kcal">Calorías (estimadas)</label><input id="al-kcal" type="number" inputmode="numeric" min="0" value="${BEBIDAS[bebida][3]}"></div>
      </div>
      <p class="ayuda" style="margin:-8px 0 14px">🔒 Las calorías son privadas y se suman a tu día de comida.</p>
      <div class="campo"><label for="al-notas">Notas (opcional)</label><input id="al-notas" maxlength="300"></div>
      <button type="button" class="boton-principal" id="al-ok">Guardar</button>`);
    const recalcular = () => {
      const [, , mlBase, kBase] = BEBIDAS[bebida];
      $("al-kcal").value = Math.round(kBase * (Number($("al-ml").value || mlBase) / mlBase) * Number($("al-cant").value || 1));
    };
    $("al-tipo").addEventListener("click", (e) => {
      const b = e.target.closest("[data-al]"); if (!b) return;
      bebida = b.dataset.al; $("al-tipo").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
      $("al-ml").value = BEBIDAS[bebida][2]; recalcular();
    });
    $("al-cant").addEventListener("input", recalcular); $("al-ml").addEventListener("input", recalcular);
    $("al-ok").addEventListener("click", async () => {
      const r = await db.from("alcohol").insert({ user_id: usuario.id, fecha: $("al-fecha").value, hora: ahoraHHMM(), bebida,
        cantidad: Number($("al-cant").value), ml: Number($("al-ml").value) || null, kcal: Number($("al-kcal").value) || 0, notas: $("al-notas").value.trim() || null });
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja(); avisar("Bebida registrada.", "ok"); vistaHabitos();
    });
  }

  function hojaCiclo(id = null, actuales = []) {
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">🌸 ${id ? "Síntomas" : "Empezó mi periodo"}</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      ${id ? "" : `<div class="campo"><label for="ci-ini">Día de inicio</label><select id="ci-ini"><option value="${yo().hoy}">Hoy</option><option value="${sumarDias(yo().hoy, -1)}">Ayer</option><option value="${sumarDias(yo().hoy, -2)}">Anteayer</option></select></div>`}
      <span class="grupo-titulo">Síntomas (opcional)</span>${chipsMulti("ci-sint", SINTOMAS, actuales)}
      <span class="grupo-titulo" style="margin-top:14px">Intensidad</span>${chipsMulti("ci-int", ["Leve", "Moderada", "Fuerte"])}
      <button type="button" class="boton-principal" id="ci-ok" style="margin-top:16px">Guardar</button>`);
    activarChips("ci-sint"); activarChips("ci-int", true);
    $("ci-ok").addEventListener("click", async () => {
      const int = { Leve: 1, Moderada: 2, Fuerte: 3 }[leerChips("ci-int")[0]] || null;
      const r = id
        ? await db.from("ciclo").update({ sintomas: leerChips("ci-sint"), intensidad: int }).eq("id", id)
        : await db.from("ciclo").insert({ user_id: usuario.id, inicio: $("ci-ini").value, sintomas: leerChips("ci-sint"), intensidad: int });
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja(); avisar(id ? "Síntomas guardados." : "Registrado. Cuídate mucho estos días. 🌸", "ok"); vistaHabitos();
    });
  }

  function hojaDolor() {
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">🩹 Dolor o lesión</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <div class="opciones campo"><label><input type="radio" name="do-tipo" value="dolor" checked><span>⚡ Dolor</span></label><label><input type="radio" name="do-tipo" value="lesion"><span>🩹 Lesión</span></label></div>
      <div class="campo"><label for="do-zona">Zona</label><input id="do-zona" maxlength="80" placeholder="Ej.: rodilla derecha, zona lumbar"></div>
      <div class="campo"><label for="do-int">Intensidad: <strong id="do-int-v">4</strong>/10</label><input id="do-int" type="range" min="1" max="10" value="4" style="height:auto;padding:0;border:0;background:none"></div>
      <div class="campo"><label for="do-mom">¿Cuándo aparece?</label><input id="do-mom" maxlength="200" placeholder="Ej.: al bajar en la sentadilla, al correr"></div>
      <div class="campo"><label for="do-notas">Notas (opcional)</label><textarea id="do-notas" maxlength="500"></textarea></div>
      <button type="button" class="boton-principal" id="do-ok">Guardar</button>
      <p class="ayuda">Si es una lesión que te impide entrenar, justifica el día como "Lesión" y, desde el segundo día, puedes pedir una pausa.</p>`);
    $("do-int").addEventListener("input", (e) => ($("do-int-v").textContent = e.target.value));
    $("do-ok").addEventListener("click", async () => {
      const zona = $("do-zona").value.trim(); if (!zona) return avisar("Indica la zona.");
      const r = await db.from("dolores").insert({ user_id: usuario.id, fecha: yo().hoy, tipo: document.querySelector('input[name="do-tipo"]:checked').value,
        zona, intensidad: Number($("do-int").value), momento: $("do-mom").value.trim() || null, notas: $("do-notas").value.trim() || null });
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja(); avisar("Registrado.", "ok");
      if (perfil.coach_activo && confirm("¿Quieres contarle al coach para que te sugiera ajustes?")) return vistaCoach("lesion");
      vistaHabitos();
    });
  }

  async function hojaEpisodio() {
    const hoy = yo().hoy;
    const { data: comidas } = await db.from("comidas").select("id, nombre, categoria, fecha, hora").eq("user_id", usuario.id).eq("estado", "completa").eq("saltada", false)
      .gte("fecha", sumarDias(hoy, -1)).order("fecha", { ascending: false }).order("hora", { ascending: false });
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">📓 Registro personal</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">Gracias por registrarlo. Esto no resta puntos ni cambia tu mascota: sirve para entender qué pasa y cuidarte mejor.</p>
      <div class="fila campo">
        <div><label for="ep-fecha">Día</label><select id="ep-fecha"><option value="${hoy}">Hoy</option><option value="${sumarDias(hoy, -1)}">Ayer</option></select></div>
        <div><label for="ep-hora">Hora aproximada</label><input id="ep-hora" type="time" value="${ahoraHHMM()}"></div>
      </div>
      ${(comidas || []).length ? `<span class="grupo-titulo">Comidas que formaron parte (no cuentan en tu regla de comidas)</span>
        <div class="lista" id="ep-comidas">${comidas.map((c) => `<label class="interruptor" style="padding:10px 12px"><span style="font-weight:500">${CAT[c.categoria].emoji} ${esc(c.nombre)} <small>· ${etiquetaFecha(c.fecha).toLowerCase()}</small></span><input type="checkbox" value="${c.id}"></label>`).join("")}</div>` : ""}
      <span class="grupo-titulo" style="margin-top:14px">¿Qué estabas haciendo? (opcional)</span>${chipsMulti("ep-sit", SITUACIONES)}
      <span class="grupo-titulo" style="margin-top:14px">¿Cómo te sentías? (opcional)</span>${chipsMulti("ep-emo", EMOCIONES)}
      <div class="campo" style="margin-top:14px"><label for="ep-nota">Lo que quieras contar (opcional)</label><textarea id="ep-nota" maxlength="2000"></textarea></div>
      <label class="interruptor campo"><span>Compartir este registro con ${esc(pareja()?.nombre || "tu pareja")}</span><input id="ep-comp" type="checkbox"></label>
      <button type="button" class="boton-principal" id="ep-ok">Guardar</button>`);
    activarChips("ep-sit"); activarChips("ep-emo");
    $("ep-ok").addEventListener("click", async () => {
      const ids = [...document.querySelectorAll("#ep-comidas input:checked")].map((i) => Number(i.value));
      const r = await db.from("episodios").insert({ user_id: usuario.id, fecha: $("ep-fecha").value, hora: $("ep-hora").value || null, comidas: ids,
        situacion: leerChips("ep-sit"), emociones: leerChips("ep-emo"), nota: $("ep-nota").value.trim() || null, compartido: $("ep-comp").checked });
      if (r.error) return avisar(errorLegible(r.error));
      cerrarHoja(); avisar("Registrado. Sé amable contigo. 💗", "ok");
      if (perfil.coach_activo && confirm("¿Quieres hablarlo con el coach? Puede ayudarte a encontrar estrategias.")) return vistaCoach("episodio");
      vistaHabitos();
    });
  }

  function hojaInbody() {
    let archivo = null;
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">📊 InBody</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">🔒 Privado. Puedes compartirlo con tu pareja si quieres.</p>
      <label class="boton-archivo secundario"><input type="file" accept="image/*" id="ib-foto">📷 Foto del informe</label>
      ${perfil.coach_activo ? `<p class="ayuda" id="ib-estado">Con la foto, la IA intentará leer los valores; revísalos antes de guardar.</p>` : ""}
      <div class="fila campo" style="margin-top:12px">
        <div><label for="ib-fecha">Fecha</label><input id="ib-fecha" type="date" value="${yo().hoy}" max="${yo().hoy}"></div>
        <div><label for="ib-peso">Peso (kg)</label><input id="ib-peso" type="number" inputmode="decimal" step="0.1"></div>
      </div>
      <div class="fila campo">
        <div><label for="ib-grasa">Grasa corporal (%)</label><input id="ib-grasa" type="number" inputmode="decimal" step="0.1"></div>
        <div><label for="ib-musc">Masa muscular (kg)</label><input id="ib-musc" type="number" inputmode="decimal" step="0.1"></div>
      </div>
      <div class="campo"><label for="ib-mgrasa">Masa grasa (kg)</label><input id="ib-mgrasa" type="number" inputmode="decimal" step="0.1"></div>
      <input type="hidden" id="ib-otros" value="{}">
      <label class="interruptor campo"><span>Compartir con ${esc(pareja()?.nombre || "tu pareja")}</span><input id="ib-comp" type="checkbox"></label>
      <button type="button" class="boton-principal" id="ib-ok">Guardar</button>`);
    $("ib-foto").addEventListener("change", async (e) => {
      archivo = e.target.files[0] || null;
      if (!archivo || !perfil.coach_activo) return;
      $("ib-estado").textContent = "🤖 Leyendo el informe…";
      try {
        const { informe: i } = await llamarCoach({ accion: "inbody", imagen: await aBase64(await comprimir(archivo, 1400, 0.8)) });
        if (i.fecha) $("ib-fecha").value = i.fecha;
        if (i.peso_kg) $("ib-peso").value = i.peso_kg;
        if (i.grasa_pct) $("ib-grasa").value = i.grasa_pct;
        if (i.masa_muscular_kg) $("ib-musc").value = i.masa_muscular_kg;
        if (i.masa_grasa_kg) $("ib-mgrasa").value = i.masa_grasa_kg;
        $("ib-otros").value = JSON.stringify(i.otros || {});
        $("ib-estado").textContent = "Valores leídos: revísalos antes de guardar.";
      } catch (err) { $("ib-estado").textContent = errorLegible(err); }
    });
    $("ib-ok").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        let ruta = null;
        if (archivo) {
          ruta = `${usuario.id}/inbody-${Date.now()}.jpg`;
          const up = await db.storage.from("cuerpo").upload(ruta, await comprimir(archivo, 1600, 0.8), { contentType: "image/jpeg" });
          if (up.error) throw up.error;
        }
        const n = (id) => ($(id).value === "" ? null : Number($(id).value));
        const r = await db.from("mediciones").insert({ user_id: usuario.id, tipo: "inbody", fecha: $("ib-fecha").value, peso_kg: n("ib-peso"),
          grasa_pct: n("ib-grasa"), masa_muscular_kg: n("ib-musc"), masa_grasa_kg: n("ib-mgrasa"), otros: JSON.parse($("ib-otros").value || "{}"),
          archivo_ruta: ruta, compartido: $("ib-comp").checked });
        if (r.error) throw r.error;
        cerrarHoja(); avisar("InBody guardado. 🔒", "ok"); vistaHabitos();
      } catch (err) { e.target.disabled = false; avisar(errorLegible(err)); }
    });
  }

  function hojaFotoProgreso() {
    let archivo = null;
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">📸 Foto de progreso</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="sub">🔒 Privada por defecto. Para comparar mejor, usa la misma luz, lugar y postura.</p>
      <div id="fp-prev"><label class="agregar-foto" style="aspect-ratio:auto;padding:28px"><input type="file" accept="image/*" id="fp-archivo">📷 Tomar o elegir foto</label></div>
      <div class="campo" style="margin-top:12px"><label for="fp-nota">Nota (opcional)</label><input id="fp-nota" maxlength="300"></div>
      <label class="interruptor campo"><span>Compartir esta foto con ${esc(pareja()?.nombre || "tu pareja")}</span><input id="fp-comp" type="checkbox"></label>
      <button type="button" class="boton-principal" id="fp-ok">Guardar</button>`);
    $("fp-archivo").addEventListener("change", (e) => {
      archivo = e.target.files[0] || null;
      if (archivo) $("fp-prev").innerHTML = `<div class="galeria"><img src="${URL.createObjectURL(archivo)}" alt="Vista previa"></div>`;
    });
    $("fp-ok").addEventListener("click", async (e) => {
      if (!archivo) return avisar("Elige la foto.");
      e.target.disabled = true;
      try {
        const ruta = `${usuario.id}/progreso-${Date.now()}.jpg`;
        const up = await db.storage.from("cuerpo").upload(ruta, await comprimir(archivo, 1400, 0.8), { contentType: "image/jpeg" });
        if (up.error) throw up.error;
        const r = await db.from("fotos_progreso").insert({ user_id: usuario.id, fecha: yo().hoy, ruta, compartida: $("fp-comp").checked, nota: $("fp-nota").value.trim() || null });
        if (r.error) throw r.error;
        cerrarHoja(); avisar("Foto guardada. 🔒", "ok"); vistaHabitos();
      } catch (err) { e.target.disabled = false; avisar(errorLegible(err)); }
    });
  }

  async function hojaVerFotos() {
    const quien = habitosDe === "yo" ? yo() : pareja();
    const { data } = await db.from("fotos_progreso").select("*").eq("user_id", quien.id).order("fecha", { ascending: true });
    const lista = data || [];
    const { data: urls } = await db.storage.from("cuerpo").createSignedUrls(lista.map((f) => f.ruta), 1800);
    const u = Object.fromEntries((urls || []).map((x) => [x.path, x.signedUrl]));
    const esMio = quien.id === usuario.id;
    let a = 0, b = lista.length - 1;
    const pintar = () => {
      $("vf-comp").innerHTML = lista.length > 1 ? `<div class="comparar">
          <figure><img src="${u[lista[a].ruta]}" alt="Antes"><figcaption>${fechaCorta(lista[a].fecha)}</figcaption></figure>
          <figure><img src="${u[lista[b].ruta]}" alt="Después"><figcaption>${fechaCorta(lista[b].fecha)}</figcaption></figure></div>` : "";
    };
    abrirHoja(`
      <div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.5rem">🖼️ Progreso</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      ${lista.length > 1 ? `<div class="fila campo"><div><label for="vf-a">Antes</label><select id="vf-a">${lista.map((f, i) => `<option value="${i}" ${i === a ? "selected" : ""}>${fechaCorta(f.fecha)}</option>`).join("")}</select></div>
        <div><label for="vf-b">Después</label><select id="vf-b">${lista.map((f, i) => `<option value="${i}" ${i === b ? "selected" : ""}>${fechaCorta(f.fecha)}</option>`).join("")}</select></div></div>` : ""}
      <div id="vf-comp"></div>
      <div class="lista" style="margin-top:14px">${[...lista].reverse().map((f) => `
        <div class="tarjeta" style="margin:0">
          <img src="${u[f.ruta]}" alt="Foto de progreso" style="width:100%;border-radius:12px">
          <p class="ayuda">${fechaCorta(f.fecha)}${f.nota ? " · " + esc(f.nota) : ""}</p>
          ${esMio ? `<label class="interruptor"><span>Compartida</span><input type="checkbox" data-fp-comp="${f.id}" ${f.compartida ? "checked" : ""}></label>
            <button type="button" class="enlace" data-fp-borrar="${f.id}" data-ruta="${esc(f.ruta)}" style="color:var(--error)">Eliminar</button>` : ""}
        </div>`).join("")}</div>`);
    pintar();
    $("vf-a")?.addEventListener("change", (e) => { a = Number(e.target.value); pintar(); });
    $("vf-b")?.addEventListener("change", (e) => { b = Number(e.target.value); pintar(); });
    $("hoja-contenido").addEventListener("change", async (e) => {
      const c = e.target.closest("[data-fp-comp]"); if (!c) return;
      const r = await db.from("fotos_progreso").update({ compartida: c.checked }).eq("id", Number(c.dataset.fpComp));
      if (r.error) { c.checked = !c.checked; return avisar(errorLegible(r.error)); }
      avisar(c.checked ? "Ahora tu pareja puede ver esta foto." : "Foto privada otra vez.", "ok");
    });
    $("hoja-contenido").addEventListener("click", async (e) => {
      const d = e.target.closest("[data-fp-borrar]"); if (!d) return;
      if (!confirm("¿Eliminar esta foto?")) return;
      await db.from("fotos_progreso").delete().eq("id", Number(d.dataset.fpBorrar));
      await db.storage.from("cuerpo").remove([d.dataset.ruta]);
      cerrarHoja(); vistaHabitos();
    });
  }

  // ---------- Apple Salud: token y Atajo
  async function vistaSalud() {
    vistaActual = "salud";
    const { data: t } = await db.from("tokens_salud").select("ultimo_uso, creado_en").eq("user_id", usuario.id).maybeSingle();
    const url = cfg.supabaseUrl.replace(/\/+$/, "") + "/functions/v1/salud";
    $("vista").innerHTML = `
      <div class="cabecera-vista"><h2 class="titulo" style="font-size:1.6rem">📲 Apple Salud</h2><button type="button" data-ir="habitos">Volver</button></div>
      <p class="sub">Un Atajo de iOS envía cada noche tus pasos y tus entrenamientos (de Strava, del reloj o de cualquier app que guarde en Salud). Los entrenamientos llegan como borradores: los completas con tu foto de evidencia.</p>
      <section class="tarjeta">
        <h3>1. Tu token personal</h3>
        <p>${t ? `Creado el ${fechaCorta(t.creado_en.slice(0, 10))}${t.ultimo_uso ? ` · último envío: ${new Date(t.ultimo_uso).toLocaleString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : " · aún sin envíos"}.` : "Todavía no tienes token."}</p>
        <div id="sl-token"></div>
        <button type="button" class="${t ? "secundario" : "boton-principal"}" id="sl-gen">${t ? "Generar uno nuevo (anula el anterior)" : "Generar token"}</button>
      </section>
      <section class="tarjeta">
        <h3>2. Dirección a la que envía el Atajo</h3>
        <p class="codigo">${esc(url)}</p>
        <button type="button" class="secundario" data-copiar="${esc(url)}">Copiar dirección</button>
      </section>
      <section class="tarjeta">
        <h3>3. Crear el Atajo</h3>
        <p>Sigue las instrucciones del chat paso a paso. Cuando funcione, aquí aparecerá la fecha del último envío.</p>
      </section>`;
    $("sl-gen").addEventListener("click", async () => {
      if (t && !confirm("El token anterior dejará de funcionar y tendrás que pegar el nuevo en el Atajo. ¿Continuar?")) return;
      const r = await db.rpc("generar_token_salud");
      if (r.error) return avisar(errorLegible(r.error));
      $("sl-token").innerHTML = `<p class="aviso">Cópialo ahora y pégalo en el Atajo: no se volverá a mostrar.</p><p class="codigo">${esc(r.data)}</p>
        <button type="button" class="boton-principal" data-copiar="${esc(r.data)}">Copiar token</button>`;
    });
  }
  $("vista").addEventListener("click", async (e) => {
    const c = e.target.closest("[data-copiar]");
    if (c) { try { await navigator.clipboard.writeText(c.dataset.copiar); avisar("Copiado.", "ok"); } catch (_) { avisar("No se pudo copiar: mantén pulsado el texto para copiarlo."); } }
  });

  // ---------- Acciones de la pestaña Hábitos
  $("vista").addEventListener("click", async (e) => {
    const de = e.target.closest("[data-hab-de]");
    if (de) { habitosDe = de.dataset.habDe; return vistaHabitos(); }
    const h = e.target.closest("[data-hab]");
    if (h) {
      const a = h.dataset.hab;
      if (a === "sueno") return hojaSueno();
      if (a === "alcohol") return hojaAlcohol();
      if (a === "ciclo-inicio") return hojaCiclo();
      if (a === "ciclo-sintomas") { const { data } = await db.from("ciclo").select("sintomas").eq("id", Number(h.dataset.id)).single(); return hojaCiclo(Number(h.dataset.id), data?.sintomas || []); }
      if (a === "ciclo-fin") { await db.from("ciclo").update({ fin: yo().hoy }).eq("id", Number(h.dataset.id)); avisar("Registrado.", "ok"); return vistaHabitos(); }
      if (a === "dolor") return hojaDolor();
      if (a === "episodio") return hojaEpisodio();
      if (a === "inbody") return hojaInbody();
      if (a === "foto") return hojaFotoProgreso();
      if (a === "fotos") return hojaVerFotos();
      if (a === "coach-lesion") return vistaCoach("lesion");
      if (a === "coach-episodio") return vistaCoach("episodio");
    }
    const ba = e.target.closest("[data-borrar-alc]");
    if (ba) { await db.from("alcohol").delete().eq("id", Number(ba.dataset.borrarAlc)); return vistaHabitos(); }
  });

  // ================================================================ MASCOTAS (fase 11)
  // Dibujo por capas en SVG: cuerpo (5 niveles), expresión y accesorios.
  function svgMascota(tipo, nivel = 3, expresion = "normal", accesorios = [], tam = 200) {
    const n = Math.max(1, Math.min(5, nivel));
    const t = (n - 1) / 4;                       // 0 = nivel 1, 1 = nivel 5
    const L = (a, b) => a + (b - a) * t;
    const ojos = (x1, y1, x2, y2, r) => {
      const ojo = (x, y) => {
        if (expresion === "feliz") return `<path d="M${x - r} ${y + 1} Q${x} ${y - r * 1.4} ${x + r} ${y + 1}" fill="none" stroke="#2E2926" stroke-width="2.6" stroke-linecap="round"/>`;
        if (expresion === "cansada") return `<path d="M${x - r} ${y} L${x + r} ${y}" stroke="#2E2926" stroke-width="2.6" stroke-linecap="round"/><path d="M${x - r * .9} ${y + r * .9} Q${x} ${y + r * 1.6} ${x + r * .9} ${y + r * .9}" fill="none" stroke="#9C7B8A" stroke-width="1.6" opacity=".7"/>`;
        if (expresion === "triste") return `<circle cx="${x}" cy="${y + 1}" r="${r * .75}" fill="#2E2926"/><path d="M${x - r * 1.1} ${y - r * 1.2} L${x + r * .6} ${y - r * .5}" stroke="#2E2926" stroke-width="2" stroke-linecap="round"/>`;
        if (expresion === "energica") return `<circle cx="${x}" cy="${y}" r="${r}" fill="#2E2926"/><circle cx="${x + r * .35}" cy="${y - r * .4}" r="${r * .38}" fill="#fff"/><circle cx="${x - r * .35}" cy="${y + r * .3}" r="${r * .18}" fill="#fff"/>`;
        return `<circle cx="${x}" cy="${y}" r="${r * .85}" fill="#2E2926"/><circle cx="${x + r * .3}" cy="${y - r * .3}" r="${r * .3}" fill="#fff"/>`;
      };
      return ojo(x1, y1) + (x2 != null ? ojo(x2, y2) : "");
    };
    const boca = (x, y, w) => {
      if (expresion === "feliz" || expresion === "energica") return `<path d="M${x - w} ${y} Q${x} ${y + w * 1.3} ${x + w} ${y}" fill="#C9576F" stroke="#2E2926" stroke-width="2" stroke-linejoin="round"/>`;
      if (expresion === "triste") return `<path d="M${x - w * .8} ${y + w * .6} Q${x} ${y - w * .3} ${x + w * .8} ${y + w * .6}" fill="none" stroke="#2E2926" stroke-width="2" stroke-linecap="round"/>`;
      if (expresion === "cansada") return `<path d="M${x - w * .6} ${y + 2} L${x + w * .6} ${y + 2}" stroke="#2E2926" stroke-width="2" stroke-linecap="round"/>`;
      return `<path d="M${x - w * .7} ${y} Q${x} ${y + w * .7} ${x + w * .7} ${y}" fill="none" stroke="#2E2926" stroke-width="2" stroke-linecap="round"/>`;
    };
    const zzz = expresion === "cansada" ? `<text x="168" y="34" font-size="16" font-weight="700" fill="#9C7B8A" class="m-zzz">z</text><text x="180" y="22" font-size="12" font-weight="700" fill="#9C7B8A" class="m-zzz">z</text>` : "";
    const lagrima = expresion === "triste" ? `<path d="M0 0 q3 6 0 9 q-3 -3 0 -9z" fill="#86ADD8" class="m-lagrima"/>` : "";
    let cuerpo = "", cabeza = {};
    if (tipo === "chihuahua") {
      // Chihuahua: nivel alto = más fuerte (pecho y patas más gruesos); nivel bajo = más delgado
      const rx = L(28, 38), ry = L(17, 25), pata = L(6, 11), cx = 92, cy = 104;
      const c = "#FBF8F5", borde = "#D8CCC4", gris = "#5F5A5C", grisC = "#8D8789", rosa = "#E9C3C6";
      cuerpo = `
        <g class="m-cola" style="transform-origin:${cx - rx + 4}px ${cy - 6}px"><path d="M${cx - rx + 4} ${cy - 6} q-22 -6 -16 -30 q4 14 18 20z" fill="${c}" stroke="${borde}" stroke-width="1.5"/></g>
        ${[cx - rx * .65, cx - rx * .25, cx + rx * .3, cx + rx * .7].map((x) => `<rect x="${x - pata / 2}" y="${cy + ry * .5}" width="${pata}" height="${L(30, 26)}" rx="${pata / 2}" fill="${c}" stroke="${borde}" stroke-width="1.5"/>`).join("")}
        <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${c}" stroke="${borde}" stroke-width="1.5"/>
        <ellipse cx="${cx - rx * .35}" cy="${cy + ry * .35}" rx="${rx * .22}" ry="${ry * .25}" fill="${grisC}" opacity=".35"/>
        <ellipse cx="${cx + rx * .45}" cy="${cy + 2}" rx="${L(12, 18)}" ry="${L(11, 17)}" fill="#F3E4E2" opacity=".8"/>
        ${n >= 4 ? `<path d="M${cx + rx * .2} ${cy - ry * .2} q8 6 0 14" fill="none" stroke="${borde}" stroke-width="1.6"/>` : ""}`;
      const hx = 138, hy = 70;
      cabeza = { hx, hy };
      cuerpo += `
        <path d="M${hx - 18} ${hy - 20} Q${hx - 40} ${hy - 34} ${hx - 52} ${hy - 26} Q${hx - 44} ${hy - 6} ${hx - 16} ${hy + 2}z" fill="${gris}"/><path d="M${hx - 20} ${hy - 15} Q${hx - 38} ${hy - 26} ${hx - 44} ${hy - 22} Q${hx - 38} ${hy - 9} ${hx - 19} ${hy - 3}z" fill="${rosa}" opacity=".8"/>
        <path d="M${hx + 18} ${hy - 20} Q${hx + 40} ${hy - 34} ${hx + 52} ${hy - 26} Q${hx + 44} ${hy - 6} ${hx + 16} ${hy + 2}z" fill="${gris}"/><path d="M${hx + 20} ${hy - 15} Q${hx + 38} ${hy - 26} ${hx + 44} ${hy - 22} Q${hx + 38} ${hy - 9} ${hx + 19} ${hy - 3}z" fill="${rosa}" opacity=".8"/>
        <ellipse cx="${hx}" cy="${hy}" rx="26" ry="27" fill="${c}" stroke="${borde}" stroke-width="1.5"/>
        <path d="M${hx - 22} ${hy + 1} Q${hx - 22} ${hy - 19} ${hx - 4} ${hy - 18} Q${hx - 3} ${hy - 14} ${hx - 6} ${hy - 12} Q${hx - 18} ${hy - 13} ${hx - 18} ${hy + 1}z" fill="${gris}"/>
        <path d="M${hx + 22} ${hy + 1} Q${hx + 22} ${hy - 19} ${hx + 4} ${hy - 18} Q${hx + 3} ${hy - 14} ${hx + 6} ${hy - 12} Q${hx + 18} ${hy - 13} ${hx + 18} ${hy + 1}z" fill="${gris}"/>
        <circle cx="${hx - 11}" cy="${hy - 3}" r="7.5" fill="none" stroke="${grisC}" stroke-width="1.6" opacity=".55"/>
        <circle cx="${hx + 11}" cy="${hy - 3}" r="7.5" fill="none" stroke="${grisC}" stroke-width="1.6" opacity=".55"/>
        <ellipse cx="${hx}" cy="${hy + 14}" rx="10" ry="8" fill="#F1E9E6"/>
        <path d="M${hx - 8} ${hy + 17} Q${hx} ${hy + 25} ${hx + 8} ${hy + 17} Q${hx} ${hy + 21} ${hx - 8} ${hy + 17}z" fill="${gris}" opacity=".85"/>
        <ellipse cx="${hx}" cy="${hy + 10}" rx="5.5" ry="4.2" fill="#232022"/>
        <path d="M${hx - 20} ${hy + 22} Q${hx} ${hy + 31} ${hx + 20} ${hy + 22}" fill="none" stroke="#5B8FC7" stroke-width="6" stroke-linecap="round"/>
        <circle cx="${hx}" cy="${hy + 30}" r="3.5" fill="#F2C94C"/>
        ${ojos(hx - 11, hy - 3, hx + 11, hy - 3, 5.2)}
        ${boca(hx, hy + 20, 4)}
        <circle cx="${hx - 17}" cy="${hy + 9}" r="3.5" fill="${rosa}" opacity=".6"/><circle cx="${hx + 17}" cy="${hy + 9}" r="3.5" fill="${rosa}" opacity=".6"/>`;
    } else {
      // Salchicha: nivel alto = más estilizada; nivel bajo = más pesada
      const rx = L(66, 56), ry = L(31, 21), cx = 98, cy = 102;
      const c = "#A9532B", cO = "#73331A", claro = "#BC6A3C";
      cuerpo = `
        <g class="m-cola" style="transform-origin:${cx - rx + 6}px ${cy - 6}px"><path d="M${cx - rx + 6} ${cy - 6} q-24 -4 -26 -22 q10 12 28 12z" fill="${cO}"/></g>
        ${[cx - rx * .7, cx - rx * .45, cx + rx * .45, cx + rx * .7].map((x, i) => `<rect x="${x - 6.5}" y="${cy + ry * .55}" width="13" height="${L(16, 20)}" rx="6.5" fill="${i % 2 ? c : cO}"/>`).join("")}
        <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${c}"/>
        <ellipse cx="${cx + 6}" cy="${cy + ry * .5}" rx="${rx * .7}" ry="${ry * .38}" fill="${claro}"/>
        <path d="M${cx - rx * .6} ${cy - ry * .75} Q${cx} ${cy - ry * 1.05} ${cx + rx * .6} ${cy - ry * .75}" fill="none" stroke="${cO}" stroke-width="3" opacity=".25" stroke-linecap="round"/>`;
      const hx = 158, hy = 74;
      cabeza = { hx, hy };
      cuerpo += `
        <circle cx="${hx}" cy="${hy}" r="23" fill="${c}"/>
        <ellipse cx="${hx + 22}" cy="${hy + 9}" rx="18" ry="11" fill="${c}"/>
        <ellipse cx="${hx + 26}" cy="${hy + 13}" rx="13" ry="6" fill="#8F7E77" opacity=".75"/>
        <ellipse cx="${hx + 30}" cy="${hy + 6}" rx="9" ry="5" fill="#5A3A2E" opacity=".35"/>
        <ellipse cx="${hx + 39}" cy="${hy + 5}" rx="5.5" ry="4.5" fill="#1F1B1A"/>
        <path d="M${hx - 26} ${hy + 18} Q${hx - 6} ${hy + 30} ${hx + 10} ${hy + 20}" fill="none" stroke="#E07A99" stroke-width="6" stroke-linecap="round"/>
        <circle cx="${hx - 6}" cy="${hy + 27}" r="3.5" fill="#F2C94C"/>
        <g class="m-oreja" style="transform-origin:${hx - 8}px ${hy - 14}px"><path d="M${hx - 6} ${hy - 17} q-26 2 -22 38 q8 6 14 -2 q10 -14 8 -36z" fill="${cO}"/></g>
        ${ojos(hx + 6, hy - 4, null, null, 4.6)}
        ${boca(hx + 24, hy + 18, 5)}
        <circle cx="${hx + 14}" cy="${hy + 8}" r="4" fill="#F1B7C4" opacity=".55"/>`;
    }
    const { hx, hy } = cabeza;
    const acc = {
      banda: `<path d="M${hx - 24} ${hy - 12} Q${hx} ${hy - 24} ${hx + 24} ${hy - 12}" fill="none" stroke="${tipo === "chihuahua" ? "#5B8FC7" : "#E07A99"}" stroke-width="7" stroke-linecap="round"/>`,
      gorro: `<path d="M${hx - 20} ${hy - 16} Q${hx} ${hy - 50} ${hx + 26} ${hy - 30} L${hx + 16} ${hy - 14}z" fill="#86ADD8"/><circle cx="${hx + 28}" cy="${hy - 30}" r="5" fill="#fff"/><path d="M${hx - 22} ${hy - 15} Q${hx} ${hy - 24} ${hx + 18} ${hy - 13}" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>`,
      corazon: `<path class="m-corazon" d="M30 36 c-6 -8 -18 -2 -12 8 l12 12 l12 -12 c6 -10 -6 -16 -12 -8z" fill="#E07A99"/>`,
      trofeo: `<g transform="translate(18 112)"><rect x="6" y="22" width="16" height="5" rx="2" fill="#C9A227"/><rect x="11" y="16" width="6" height="7" fill="#C9A227"/><path d="M2 0 h24 v6 a12 12 0 0 1 -24 0z" fill="#F2C94C"/></g>`,
      venda: `<rect x="${tipo === "chihuahua" ? 108 : 132}" y="${tipo === "chihuahua" ? 122 : 120}" width="${tipo === "chihuahua" ? 14 : 16}" height="7" rx="2" fill="#fff" stroke="#E3D6CF"/>`,
      gota: `<path d="M184 108 q6 9 0 13 q-6 -4 0 -13z" fill="#86ADD8"/>`
    };
    const capas = accesorios.filter((a) => acc[a]).map((a) => acc[a]).join("");
    return `<svg class="mascota m-${expresion}" viewBox="0 0 210 160" width="${tam}" height="${tam * 160 / 210}" role="img" aria-label="Mascota">
      <ellipse cx="105" cy="150" rx="72" ry="6" fill="#2E2926" opacity=".08"/>
      <g class="m-cuerpo">${cuerpo}${capas}</g>${zzz}
      ${lagrima ? `<g transform="translate(${tipo === "chihuahua" ? hx - 12 : hx + 2} ${hy + 4})">${lagrima}</g>` : ""}
    </svg>`;
  }

  const NIVEL_TXT = { 1: "Necesita cariño", 2: "Con poca energía", 3: "Estable", 4: "En forma", 5: "¡Radiante!" };
  const COMP_TXT = { ejercicio: "🏋️ Ejercicio", nutricion: "🎯 Objetivos de nutrición", saludable: "🥗 Alimentación saludable", sueno: "😴 Sueño", alcohol: "🍷 Alcohol" };
  let cacheMascotas = null;
  async function cargarMascotas() {
    const { data, error } = await db.rpc("mascotas");
    if (!error) cacheMascotas = data;
    return cacheMascotas;
  }
  const nombreMascota = (m) => m.mascota_nombre || (m.tipo === "chihuahua" ? "Tu chihuahua" : "Tu salchicha");

  // Mascotas pequeñas en las tarjetas de Inicio
  async function pintarMascotasInicio() {
    const lista = await cargarMascotas();
    for (const m of lista || []) {
      const el = document.querySelector(`[data-masc="${m.user_id}"]`);
      if (el) el.innerHTML = svgMascota(m.tipo, m.nivel, m.expresion, m.accesorios, 96) +
        `<span class="masc-nota">${m.puntaje != null ? Math.round(m.puntaje) : "—"}<small>/100</small></span>`;
    }
  }

  // Tarjeta grande en Hábitos
  async function tarjetaMascota(quienId) {
    const [lista, hist] = await Promise.all([cargarMascotas(), db.rpc("historial_habitos", { p_user: quienId, p_dias: 14 })]);
    const m = (lista || []).find((x) => x.user_id === quienId);
    if (!m) return "";
    const esMia = quienId === usuario.id;
    const det = m.detalle;
    const comps = det?.componentes || {};
    const filas = Object.entries(COMP_TXT).map(([k, t]) => {
      const c = comps[k];
      if (!c) return `<div class="nutri-cab" style="padding:5px 0"><span>${t}</span><strong class="ayuda" style="margin:0">pendiente</strong></div>`;
      return `<div class="nutri-fila" style="padding:5px 0"><div class="nutri-cab"><span>${t}</span><strong>${r1(c.frac * c.peso)} / ${c.peso}</strong></div>
        <div class="progreso"><span style="width:${c.frac * 100}%"></span></div></div>`;
    }).join("");
    const serie = hist.data || [];
    const barras = serie.length ? `<div class="barras-hab">${serie.map((h) => `<span title="${h.fecha}"><i style="height:${Math.max(4, h.puntaje || 0)}%"></i><small>${fmt(h.fecha, { weekday: "narrow" })}</small></span>`).join("")}</div>` : "";
    return `
      <section class="tarjeta tarjeta-mascota ${m.tema || ""}">
        <div class="mascota-grande">${svgMascota(m.tipo, m.nivel, m.expresion, m.accesorios, 240)}</div>
        <h3 style="text-align:center;margin-top:4px">${esc(nombreMascota(m))} · ${NIVEL_TXT[m.nivel]}</h3>
        <p style="text-align:center">Puntuación de hábitos ${m.fuente === "ayer" ? "(de ayer: hoy aún no hay registros)" : "de hoy"}: <strong>${m.puntaje != null ? Math.round(m.puntaje) : "—"}/100</strong></p>
        ${det ? `<details class="historial"><summary>Cómo se calcula hoy</summary>${filas}
          ${det.bono ? `<p class="ayuda">Bonos: +${r1(det.bono)} (comidas juntos, entrenamiento extra o pasos)</p>` : ""}
          ${det.resta ? `<p class="ayuda">Regla de cantidad de comidas: −${r1(det.resta)}</p>` : ""}
          ${det.dia_libre ? `<p class="ayuda">🎉 Día libre: solo suma lo que cumples.</p>` : ""}
          <p class="ayuda">Lo pendiente no resta hasta que termina el día. Los registros personales nunca afectan la puntuación.</p></details>` : ""}
        ${barras}
        ${esMia ? `<p class="ayuda" style="text-align:center">La mascota es una motivación, no un diagnóstico de salud.</p>` : ""}
      </section>`;
  }

  // ================================================================ ESTADÍSTICAS Y COACH AVANZADO (fase 12)
  // ---------- Gráficos simples en SVG
  function grafico(series, etiquetas, { tipo = "linea", unidad = "", alto = 150, min = null, max = null } = {}) {
    const W = 340, H = alto, pl = 34, pr = 8, pt = 10, pb = 22;
    const vals = series.flatMap((s) => s.valores).filter((v) => v != null && isFinite(v));
    if (!vals.length) return `<p class="ayuda">Sin datos en este periodo.</p>`;
    let lo = min ?? Math.min(0, ...vals), hi = max ?? Math.max(...vals);
    if (hi === lo) hi = lo + 1;
    if (min == null && tipo === "linea") { const pad = (hi - Math.min(...vals)) * .15; lo = Math.max(0, Math.min(...vals) - pad); }
    const n = etiquetas.length, paso = (W - pl - pr) / Math.max(1, n - (tipo === "linea" ? 1 : 0));
    const X = (i) => pl + (tipo === "linea" ? i * paso : i * paso + paso / 2);
    const Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
    const marcas = [lo, (lo + hi) / 2, hi].map((v) => `<text x="${pl - 4}" y="${Y(v) + 3}" font-size="9" text-anchor="end" fill="var(--texto-suave)">${Math.round(v)}</text>
      <line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--borde)" stroke-width="1"/>`).join("");
    const cada = Math.ceil(n / 7);
    const ejeX = etiquetas.map((e, i) => i % cada === 0 || i === n - 1 ? `<text x="${X(i)}" y="${H - 6}" font-size="9" text-anchor="middle" fill="var(--texto-suave)">${esc(e)}</text>` : "").join("");
    let cuerpo = "";
    if (tipo === "barras") {
      const ancho = Math.max(3, paso / series.length * .7);
      series.forEach((s, k) => s.valores.forEach((v, i) => {
        if (v == null) return;
        const x = X(i) - (ancho * series.length) / 2 + k * ancho;
        cuerpo += `<rect x="${x}" y="${Y(Math.max(v, lo))}" width="${ancho - 1}" height="${Math.max(0, Y(lo) - Y(Math.max(v, lo)))}" rx="2" fill="${s.color}"/>`;
      }));
    } else {
      series.forEach((s) => {
        const pts = s.valores.map((v, i) => (v == null ? null : `${X(i)},${Y(v)}`));
        let tramo = [], d = "";
        pts.forEach((p) => { if (p) tramo.push(p); else { if (tramo.length) d += "M" + tramo.join(" L"); tramo = []; } });
        if (tramo.length) d += "M" + tramo.join(" L");
        cuerpo += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" ${s.punteada ? 'stroke-dasharray="5 4"' : ""}/>`;
        cuerpo += s.valores.map((v, i) => (v == null ? "" : `<circle cx="${X(i)}" cy="${Y(v)}" r="${n > 40 ? 1.5 : 2.6}" fill="${s.color}"/>`)).join("");
      });
    }
    const leyenda = series.length > 1 ? `<div class="leyenda">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.nombre)}</span>`).join("")}</div>` : "";
    return `<svg viewBox="0 0 ${W} ${H}" class="grafico" role="img" aria-label="Gráfico">${marcas}${cuerpo}${ejeX}</svg>${leyenda}${unidad ? `<p class="ayuda" style="margin-top:2px">${unidad}</p>` : ""}`;
  }

  // ---------- Agrupación por día, semana o mes
  function agrupar(dias, grano) {
    const clave = (f) => grano === "dia" ? f : grano === "semana" ? lunesDe(f) : f.slice(0, 7) + "-01";
    const grupos = new Map();
    for (const d of dias) { const k = clave(d.fecha); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(d); }
    return [...grupos.entries()].map(([k, l]) => ({ clave: k, dias: l }));
  }
  const lunesDe = (f) => { const d = aFecha(f); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const suma = (l, k) => l.reduce((a, d) => a + (Number(d[k]) || 0), 0);
  const media = (l, k, filtro = (d) => d[k] != null) => { const x = l.filter(filtro); return x.length ? x.reduce((a, d) => a + Number(d[k]), 0) / x.length : null; };
  const etiquetaGrupo = (k, grano) => grano === "dia" ? fmt(k, { day: "numeric" }) : grano === "semana" ? fmt(k, { day: "numeric", month: "short" }) : fmt(k, { month: "short" });

  let estFiltro = { periodo: 30, quien: "yo" };
  const TIPO_NOMBRE = (t) => (TIPO[t] ? TIPO[t].emoji + " " + TIPO[t].nombre : t);
  const ANIMO_NOMBRE = Object.fromEntries((typeof ANIMOS !== "undefined" ? ANIMOS : []).map(([k, e, n]) => [k, e + " " + n]));

  async function vistaEstadisticas() {
    vistaActual = "estadisticas";
    const y = yo(), p = pareja();
    const hasta = y.hoy, desde = sumarDias(hasta, -(estFiltro.periodo - 1));
    const grano = estFiltro.periodo <= 31 ? "dia" : estFiltro.periodo <= 120 ? "semana" : "mes";
    $("vista").innerHTML = `
      <div class="cabecera-vista"><h2 class="titulo">📊 Estadísticas</h2><button type="button" data-ir="mas">Volver</button></div>
      <div class="segmentado" id="es-quien">
        <button type="button" data-q="yo" aria-pressed="${estFiltro.quien === "yo"}">Mías</button>
        <button type="button" data-q="pareja" aria-pressed="${estFiltro.quien === "pareja"}">${esc(p?.nombre || "Pareja")}</button>
        <button type="button" data-q="ambos" aria-pressed="${estFiltro.quien === "ambos"}">Comparar</button>
      </div>
      <div class="chips" id="es-periodo" style="margin-bottom:14px">${[[7, "7 días"], [30, "30 días"], [90, "3 meses"], [365, "12 meses"]].map(([d, t]) =>
        `<button type="button" data-p="${d}" aria-pressed="${estFiltro.periodo === d}">${t}</button>`).join("")}</div>
      <div id="es-cont"><p class="vacio">Calculando…</p></div>`;
    const ids = estFiltro.quien === "yo" ? [y.id] : estFiltro.quien === "pareja" ? [p.id] : [y.id, p.id];
    const res = await Promise.all(ids.map((id) => db.rpc("estadisticas", { p_user: id, p_desde: desde, p_hasta: hasta })));
    if (res.some((r) => r.error)) return avisar(errorLegible(res.find((r) => r.error).error) + ". ¿Ejecutaste fase12.sql?");
    if (vistaActual !== "estadisticas") return;
    const datos = res.map((r, i) => ({ ...r.data, persona: ids[i] === y.id ? y : p }));
    const color = (d) => (d.persona.id === y.id ? (perfil.tema === "azul" ? "#5B8FC7" : "#B5607A") : (perfil.tema === "azul" ? "#B5607A" : "#5B8FC7"));
    const grupos = datos.map((d) => agrupar(d.dias, grano));
    const etiquetas = grupos[0].map((g) => etiquetaGrupo(g.clave, grano));
    const serie = (fn, nombreExtra = "") => datos.map((d, i) => ({ nombre: d.persona.nombre + nombreExtra, color: color(d), valores: grupos[i].map((g) => fn(g.dias)) }));
    const uno = datos.length === 1 ? datos[0] : null;
    const tarjetaNum = (t, v, sub = "") => `<div class="stat"><span>${t}</span><strong>${v}</strong>${sub ? `<small>${sub}</small>` : ""}</div>`;
    const porPersona = (fn) => datos.map((d) => `<div class="stat-persona"><span class="nombre-${d.persona.id === y.id ? perfil.tema : (perfil.tema === "azul" ? "rosa" : "azul")}">${esc(d.persona.nombre)}</span>${fn(d)}</div>`).join("");

    let html = "";
    // Competencia
    const semanas = datos.map((d) => d.semanas || []);
    if (semanas.some((s) => s.length)) {
      const todas = [...new Set(semanas.flat().map((s) => s.semana))].sort();
      html += `<section class="tarjeta"><h3>🏆 Competencia</h3>
        ${grafico(datos.map((d, i) => ({ nombre: d.persona.nombre, color: color(d), valores: todas.map((w) => semanas[i].find((s) => s.semana === w)?.puntos ?? null) })), todas.map((w) => fmt(w, { day: "numeric", month: "short" })), { unidad: "Puntos por semana cerrada" })}
        ${porPersona((d) => `<div class="stats">${tarjetaNum("Puntos", d.semanas.reduce((a, s) => a + s.puntos, 0))}${tarjetaNum("Cumplimiento", d.semanas.length ? Math.round(d.semanas.reduce((a, s) => a + Number(s.pct), 0) / d.semanas.length) + " %" : "—")}${tarjetaNum("Faltas", d.semanas.reduce((a, s) => a + s.faltas, 0))}</div>`)}
      </section>`;
    }
    // Ejercicio
    html += `<section class="tarjeta"><h3>🏋️ Ejercicio</h3>
      ${grafico(serie((l) => suma(l, "entrenos")), etiquetas, { tipo: "barras", unidad: `Entrenamientos válidos por ${grano === "dia" ? "día" : grano}` })}
      ${porPersona((d) => { const e = suma(d.dias, "entrenos"), m = suma(d.dias, "minutos"); return `<div class="stats">${tarjetaNum("Entrenamientos", e)}${tarjetaNum("Minutos", m.toLocaleString("es"))}${tarjetaNum("Promedio", e ? Math.round(m / e) + " min" : "—")}${tarjetaNum("Juntos", suma(d.dias, "juntos"))}</div>`; })}
      ${uno ? `${Object.keys(uno.tipos || {}).length ? `<span class="grupo-titulo" style="margin-top:12px">Por tipo</span>${barrasLista(uno.tipos, TIPO_NOMBRE)}` : ""}
        ${Object.keys(uno.zonas || {}).length ? `<span class="grupo-titulo" style="margin-top:12px">Zonas trabajadas</span>${barrasLista(uno.zonas, (z) => (ZONAS_CUERPO.find((x) => x[0] === z)?.[1]) || z)}` : ""}
        ${Object.keys(uno.animos || {}).length ? `<span class="grupo-titulo" style="margin-top:12px">Cómo te sentiste después</span>${barrasLista(uno.animos, (a) => ANIMO_NOMBRE[a] || a)}` : ""}` : ""}
    </section>`;
    // Nutrición
    const conComida = (l) => l.filter((d) => d.comidas > 0);
    html += `<section class="tarjeta"><h3>🍽️ Alimentación</h3>
      ${grafico(serie((l) => media(l, "pct")), etiquetas, { min: 0, max: 100, unidad: "% de alimentación saludable" })}
      ${uno?.privado && uno.dias.some((d) => d.kcal != null) ? `<span class="grupo-titulo" style="margin-top:12px">🔒 Calorías (promedio de días con registro)</span>${grafico(serie((l) => media(conComida(l), "kcal")), etiquetas, { unidad: "kcal por día" })}` : ""}
      ${datos.some((d) => d.macros) ? `<span class="grupo-titulo" style="margin-top:12px">Proteína promedio</span>${grafico(datos.filter((d) => d.macros).map((d, i) => ({ nombre: d.persona.nombre, color: color(d), valores: agrupar(d.dias, grano).map((g) => media(conComida(g.dias), "proteina")) })), etiquetas, { unidad: "g por día" })}` : ""}
      ${porPersona((d) => { const cd = conComida(d.dias); return `<div class="stats">${tarjetaNum("Saludable", media(d.dias, "pct") != null ? Math.round(media(d.dias, "pct")) + " %" : "—")}${tarjetaNum("Días con registro", cd.length)}${tarjetaNum("Comidas libres", suma(d.dias, "libres"))}
        ${d.privado && media(cd, "kcal") != null ? tarjetaNum("🔒 kcal/día", Math.round(media(cd, "kcal"))) : ""}
        ${d.macros && cd.length ? tarjetaNum("P / C / G", `${Math.round(media(cd, "proteina") || 0)} / ${Math.round(media(cd, "carbohidratos") || 0)} / ${Math.round(media(cd, "grasas") || 0)}`, "g por día") : ""}</div>`; })}
    </section>`;
    // Hábitos
    html += `<section class="tarjeta"><h3>🌙 Hábitos</h3>
      ${grafico(serie((l) => media(l, "puntaje")), etiquetas, { min: 0, max: 100, unidad: "Puntuación de hábitos" })}
      <span class="grupo-titulo" style="margin-top:12px">😴 Horas de sueño</span>
      ${grafico(serie((l) => media(l, "sueno_h")), etiquetas, { unidad: "Horas por noche (las salidas nocturnas neutrales no cuentan)" })}
      ${porPersona((d) => `<div class="stats">${tarjetaNum("Puntuación", media(d.dias, "puntaje") != null ? Math.round(media(d.dias, "puntaje")) : "—")}${tarjetaNum("Sueño", media(d.dias, "sueno_h") != null ? r1(media(d.dias, "sueno_h")) + " h" : "—")}
        ${tarjetaNum("Noches en objetivo", (() => { const x = d.dias.filter((z) => z.sueno_puntaje != null); return x.length ? Math.round(100 * x.filter((z) => z.sueno_puntaje >= 1).length / x.length) + " %" : "—"; })())}
        ${tarjetaNum("Bebidas/semana", r1(suma(d.dias, "bebidas") / Math.max(1, d.dias.length / 7)))}
        ${tarjetaNum("Agua", media(d.dias, "agua") != null ? Math.round(media(d.dias, "agua")) + " ml" : "—")}
        ${tarjetaNum("Pasos", media(d.dias, "pasos") != null ? Math.round(media(d.dias, "pasos")).toLocaleString("es") : "—")}</div>`)}
    </section>`;
    // Cuerpo y bienestar (solo los propios)
    const mios = datos.find((d) => d.privado);
    if (mios && mios.dias.some((d) => d.peso != null)) {
      const { data: pt } = await db.rpc("pesos_tendencia", { p_dias: estFiltro.periodo });
      const sp = pt || [];
      html += `<section class="tarjeta"><h3>⚖️ Peso <span class="privado" style="margin:0">🔒</span></h3>
        ${grafico([{ nombre: "Pesajes", color: "#B9AEA8", valores: sp.map((x) => x.kg) }, { nombre: "Tendencia", color: "var(--acento)", valores: sp.map((x) => x.tendencia) }], sp.map((x) => fmt(x.fecha, { day: "numeric", month: "short" })), { unidad: "kg" })}
      </section>`;
    }
    if (mios && mios.dias.some((d) => d.animo != null)) {
      html += `<section class="tarjeta"><h3>💛 Ánimo <span class="privado" style="margin:0">🔒</span></h3>
        ${grafico([{ nombre: "Ánimo", color: "#E3A72F", valores: agrupar(mios.dias, grano).map((g) => media(g.dias, "animo")) }], etiquetas, { min: 1, max: 5, unidad: "Promedio del check-in (1 = muy mal · 5 = muy bien)" })}
        <p class="ayuda">Mirar la tendencia ayuda a notar a tiempo una racha baja. Si se mantiene, coméntalo con tu profesional de salud mental.</p>
      </section>`;
    }
    if (mios && mios.dias.some((d) => d.episodios)) {
      html += `<details class="historial tarjeta"><summary>📓 Registro personal <span class="privado" style="margin:0">🔒</span></summary>
        ${grafico([{ nombre: "Registros", color: "#9C7B8A", valores: agrupar(mios.dias, grano).map((g) => suma(g.dias, "episodios")) }], etiquetas, { tipo: "barras", unidad: "Registros en el periodo. Son datos para entender patrones, sin juicios." })}
      </details>`;
    }
    if (estFiltro.quien !== "yo") html += `<p class="ayuda">De ${esc(p?.nombre || "tu pareja")} solo ves lo que comparte: nunca sus calorías, peso, ánimo ni registros personales.</p>`;
    $("es-cont").innerHTML = html;
  }
  function barrasLista(obj, nombre) {
    const l = Object.entries(obj).sort((a, b) => b[1] - a[1]); const max = Math.max(...l.map((x) => x[1]));
    return `<div class="barras-lista">${l.map(([k, v]) => `<div><span>${esc(nombre(k))}</span><i style="width:${(v / max) * 100}%"></i><strong>${v}</strong></div>`).join("")}</div>`;
  }
  $("vista").addEventListener("click", (e) => {
    const q = e.target.closest("#es-quien [data-q]"); if (q) { estFiltro.quien = q.dataset.q; return vistaEstadisticas(); }
    const pr = e.target.closest("#es-periodo [data-p]"); if (pr) { estFiltro.periodo = Number(pr.dataset.p); return vistaEstadisticas(); }
  });

  // ---------- Fichas educativas
  const FICHAS = [
    { id: "proteina", e: "🥚", t: "La proteína y tus músculos", x: "La proteína ayuda a reparar y construir músculo después de entrenar y a sentirte saciada. Para personas que entrenan fuerza, muchas guías la sitúan entre 1.2 y 2 g por kg de peso al día. Funciona mejor repartida en 3 o 4 comidas que concentrada en una. Fuentes fáciles: huevos, yogur griego, pollo, pescado, legumbres, tofu y queso fresco." },
    { id: "fibra", e: "🥦", t: "Fibra: la gran olvidada", x: "La fibra mejora la digestión, ayuda a controlar el azúcar en sangre y te mantiene saciada más tiempo. Se suele recomendar alrededor de 25 a 30 g al día. Está en verduras, frutas con piel, legumbres, avena y cereales integrales. Si comes poca, súbela poco a poco y acompáñala con agua." },
    { id: "sueno-apetito", e: "😴", t: "Dormir poco da más hambre", x: "Cuando duermes poco cambian las hormonas que regulan el apetito: aumenta el hambre y los antojos de comida muy energética, y baja la recuperación muscular y el ánimo. Dormir lo suficiente es una de las herramientas más potentes para tus metas, tanto como el ejercicio o la comida." },
    { id: "fuerza-definir", e: "🏋️", t: "Fuerza para verte más definida", x: "Verse 'lean and toned' depende sobre todo de tener músculo. El entrenamiento de fuerza le da al cuerpo una razón para mantenerlo y construirlo, incluso cuando comes algo menos. No te vas a poner 'enorme': construir músculo es lento. Dos o tres sesiones de fuerza por semana marcan una gran diferencia." },
    { id: "progresion", e: "📈", t: "Progresar sin estancarte", x: "El cuerpo se adapta a lo que le pides, así que para seguir mejorando hay que aumentar el reto poco a poco: una repetición más, un poco más de peso, una serie extra o menos descanso. Cambia una sola cosa a la vez y registra lo que haces para saber cuándo subir." },
    { id: "pasos", e: "👣", t: "El movimiento de todos los días", x: "Caminar, subir escaleras o moverte en casa suma mucho más gasto de energía en el día que una sola sesión de ejercicio. Aumentar tus pasos es una de las formas más sencillas y sostenibles de cuidar tu salud, y además mejora el ánimo." },
    { id: "hidratacion", e: "💧", t: "Hidratación", x: "Con calor y ejercicio pierdes más agua de lo que crees, y la deshidratación se siente como cansancio, dolor de cabeza o hambre falsa. Una buena guía práctica: bebe a lo largo del día y fíjate en que la orina sea de color claro. En días de entreno o mucho calor, bebe más." },
    { id: "alcohol", e: "🍷", t: "Alcohol y recuperación", x: "El alcohol empeora la calidad del sueño aunque te ayude a dormirte, deshidrata y reduce la recuperación muscular después de entrenar. Además aporta calorías que no sacian. No hace falta eliminarlo: dejarlo para momentos especiales y alternarlo con agua ayuda mucho." },
    { id: "ciclo", e: "🌸", t: "Entrenar con tu ciclo", x: "La energía, la fuerza y el apetito pueden variar a lo largo del ciclo. En los días de más cansancio o molestias, una sesión más suave sigue contando y es mejor que forzar. Escucha a tu cuerpo, hidrátate bien e incluye alimentos con hierro, como legumbres, carne roja magra o espinacas con algo de vitamina C." },
    { id: "comer-entreno", e: "🍌", t: "Comer antes y después de entrenar", x: "No necesitas entrenar en ayunas. Una comida o snack con carbohidratos y algo de proteína 1 a 3 horas antes te da energía para rendir mejor. Después, una comida con proteína y carbohidratos ayuda a recuperarte. Lo más importante es lo que comes en el día completo." },
    { id: "azucares", e: "🍬", t: "Azúcares: naturales y añadidos", x: "No todo el azúcar es igual: el de la fruta o los lácteos viene con fibra, agua y nutrientes. Los azúcares añadidos (refrescos, dulces, salsas) son los que conviene moderar. Revisa las etiquetas: muchos productos 'saludables' llevan más azúcar del que parece." },
    { id: "etiquetas", e: "🏷️", t: "Leer una etiqueta en 30 segundos", x: "Fíjate primero en el tamaño de la porción y compara siempre por 100 g para elegir entre productos. Los ingredientes están ordenados de mayor a menor cantidad: si el azúcar aparece entre los primeros, es un producto muy azucarado. Mira proteína y fibra: cuanto más, más saciante." },
    { id: "descanso", e: "🛌", t: "El músculo crece descansando", x: "El entrenamiento es el estímulo, pero la mejora ocurre mientras descansas. Los días de descanso, el sueño y una buena alimentación son parte del plan, no una pausa en él. Si te sientes muy cansada, con dolores o sin progreso, quizás necesitas más descanso, no más entrenamiento." },
    { id: "constancia", e: "🧩", t: "Constancia antes que perfección", x: "Lo que cambia tu cuerpo es lo que haces la mayoría de los días, no un día perfecto ni uno malo. Una comida fuera de plan no arruina nada: la siguiente comida es una nueva oportunidad. Pensar en 'todo o nada' es lo que más hace abandonar." },
    { id: "estres-comida", e: "🫶", t: "Estrés, emociones y comida", x: "Comer para calmar emociones es muy común y no es un fallo de voluntad. Ayuda notar la emoción antes de comer, tener alternativas que te calmen (caminar, hablar con alguien, una ducha), no saltarte comidas y dormir bien. Si sientes que la comida te controla, un psicólogo o nutricionista especializado puede ayudarte mucho." },
    { id: "calentar", e: "🔥", t: "Calentar y evitar lesiones", x: "Unos minutos de movilidad y series suaves antes de entrenar preparan músculos y articulaciones. La técnica es más importante que el peso. Un dolor agudo, punzante o que empeora no es 'normal': detente y revísalo. Las agujetas de 1 o 2 días sí son normales." },
    { id: "cardio-fuerza", e: "🏃‍♀️", t: "Cardio y fuerza: mejor juntos", x: "El cardio cuida el corazón, la resistencia y el ánimo; la fuerza construye músculo, protege huesos y articulaciones y cambia la forma del cuerpo. Combinar los dos en la semana da los mejores resultados para la salud y la estética." },
    { id: "ejercicio-animo", e: "🌤️", t: "Moverte también cuida tu mente", x: "El ejercicio regular reduce síntomas de ansiedad y depresión y mejora el sueño y la energía. No hace falta una sesión intensa: una caminata al aire libre o una rutina corta ya ayudan. En los días difíciles, lo pequeño cuenta." }
  ];
  function hojaFicha(id) {
    const f = FICHAS.find((x) => x.id === id); if (!f) return;
    abrirHoja(`<div class="cabecera-vista"><h2 class="titulo" id="hoja-titulo" style="font-size:1.4rem">${f.e} ${esc(f.t)}</h2><button type="button" data-cerrar-hoja>Cerrar</button></div>
      <p class="coach-texto">${esc(f.x)}</p><p class="ayuda" style="margin-top:14px">Información general, no sustituye el consejo de un profesional de salud.</p>`);
  }
  function vistaAprende() {
    vistaActual = "aprende";
    $("vista").innerHTML = `<div class="cabecera-vista"><h2 class="titulo">📚 Aprende</h2><button type="button" data-ir="mas">Volver</button></div>
      <p class="sub">Fichas cortas sobre entrenamiento, alimentación y hábitos. El coach te recomienda una cada día.</p>
      <div class="lista">${FICHAS.map((f) => `<button type="button" class="item" data-ficha="${f.id}" style="grid-template-columns:40px minmax(0,1fr) auto;min-height:0">
        <span style="font-size:1.6rem">${f.e}</span><span><strong>${esc(f.t)}</strong></span><span class="lado">›</span></button>`).join("")}</div>`;
  }
  $("vista").addEventListener("click", (e) => { const f = e.target.closest("[data-ficha]"); if (f) hojaFicha(f.dataset.ficha); });
  $("hoja").addEventListener("click", (e) => { const f = e.target.closest("[data-ficha]"); if (f) hojaFicha(f.dataset.ficha); });

  // ---------- Acción del día (Inicio)
  async function cargarAccionDia(renovar = false) {
    const cont = $("accion-dia"); if (!cont || !perfil.coach_activo) return;
    cont.innerHTML = `<section class="tarjeta accion-dia"><h3>🤖 Tu acción de hoy</h3><p class="ayuda">El coach está preparando tu día…</p></section>`;
    try {
      const { contenido: c } = await llamarCoach({ accion: "diario", fecha: yo().hoy, renovar, fichas: FICHAS.map((f) => ({ id: f.id, titulo: f.t })) });
      if (!c || !$("accion-dia")) { if ($("accion-dia")) $("accion-dia").innerHTML = ""; return; }
      const ficha = FICHAS.find((f) => f.id === c.ficha_id);
      $("accion-dia").innerHTML = `<section class="tarjeta accion-dia">
        <div class="nutri-cab"><h3 style="margin:0">🤖 Tu acción de hoy</h3><button type="button" class="enlace" data-accion-renovar style="width:auto;min-height:0;padding:0;font-size:.85rem">Otra idea</button></div>
        <p style="margin-top:8px">${esc(c.accion)}</p>
        ${c.ejercicio ? `<div class="sugerencia"><strong>${c.toca_entrenar ? "🏋️ Entrenamiento sugerido" : "🧘 Si te apetece moverte"}:</strong> ${esc(c.ejercicio.tipo)}${c.ejercicio.duracion_min ? ` · ${c.ejercicio.duracion_min} min` : ""}<br><span class="ayuda" style="margin:0">${esc(c.ejercicio.detalle || "")}</span></div>` : ""}
        ${c.subir_nivel ? `<div class="sugerencia subir"><strong>🚀 ¿Lista para subir de nivel?</strong><br>${esc(c.subir_nivel)}<button type="button" class="secundario" data-ir="metas" style="margin-top:10px">Ajustar mis metas</button></div>` : ""}
        ${ficha ? `<button type="button" class="secundario" data-ficha="${ficha.id}" style="margin-top:10px">${ficha.e} Lee: ${esc(ficha.t)}</button>` : ""}
      </section>`;
    } catch (_) { if ($("accion-dia")) $("accion-dia").innerHTML = ""; }
  }
  $("vista").addEventListener("click", (e) => { if (e.target.closest("[data-accion-renovar]")) cargarAccionDia(true); });

  // ================================================================ SENSACIÓN DE APP NATIVA
  ["gesturestart", "gesturechange", "gestureend"].forEach((ev) =>
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener("touchmove", (e) => { if (e.scale && e.scale !== 1) e.preventDefault(); }, { passive: false });

  // ================================================================ ARRANQUE
  db.auth.getSession().then(({ data }) => {
    if (data.session) entrar(data.session.user);
    else mostrarAcceso("correo");
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
