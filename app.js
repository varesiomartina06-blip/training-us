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
    document.querySelectorAll("#pestanas button").forEach((b) => {
      if (b.dataset.vista === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    window.scrollTo(0, 0);
    if (!$("hoja").hidden) cerrarHoja();
    if (v === "inicio") vistaInicio();
    else if (v === "entrenar") vistaEntrenar();
    else if (v === "metas") vistaMetas();
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
    const dias = DIAS.map((d, i) => {
      const prev = sem?.dias_previstos.includes(i + 1), hecho = hechos.includes(i + 1);
      return `<span class="dia ${prev ? "on" : ""} ${hecho ? "hecho" : ""} ${hecho && !prev ? "extra" : ""}" aria-label="${d}${hecho ? ", entrenado" : prev ? ", previsto" : ""}">${hecho ? "✓" : d}</span>`;
    }).join("");
    const zonaTxt = nombreZona(p.zona);
    return `
      <section class="tarjeta ${tema}">
        <h3 class="nombre-${tema}">${nombre}${esYo ? " (tú)" : ""}</h3>
        <p>${meta ? `${Math.min(hechos.length, meta.entrenos_semana)} de ${meta.entrenos_semana} días con entrenamiento esta semana` : "Todavía sin metas del mes"}</p>
        <div class="dias">${dias}</div>
        ${sem ? "" : `<p>Sin días previstos esta semana</p>`}
        <p>Hora de ${esc(zonaTxt)}</p>
        ${!p.completado ? `<p>Aún no ha completado su perfil.</p>` : ""}
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

  function vistaInicio() {
    const p = pareja();
    const inicio = estado.fecha_inicio ? `El desafío empieza el ${fmt(estado.fecha_inicio, { day: "numeric", month: "long" })}.` : "La fecha de inicio del desafío está por definir.";
    $("vista").innerHTML = `
      <h2 class="titulo">Hola, ${esc(perfil.nombre)}</h2>
      <p class="sub">${inicio} El marcador de la competencia aparecerá aquí en la fase 3.</p>
      ${tarjetaParticipante(yo(), true)}
      ${p ? tarjetaParticipante(p, false) : ""}
      <div id="inicio-pendientes"></div>
      ${tarjetaJuntos()}`;
    cargarPendientesJuntos($("inicio-pendientes"));
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
        <span class="grupo-titulo">Tu color en la app</span>
        <div class="opciones campo">
          <label class="op-rosa"><input type="radio" name="pf-tema" value="rosa" ${temaDefecto === "rosa" ? "checked" : ""}><span>Rosa</span></label>
          <label class="op-azul"><input type="radio" name="pf-tema" value="azul" ${temaDefecto === "azul" ? "checked" : ""}><span>Azul</span></label>
        </div>
        <button type="submit" class="boton-principal">${esPrimeraVez ? "Guardar y continuar" : "Guardar cambios"}</button>
        ${esPrimeraVez ? "" : `<button type="button" id="btn-salir" class="secundario">Cerrar sesión</button>`}
      </form>`;

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
  }

  // ---------- Meta mensual
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
    const nutri = Object.fromEntries(n.data.filter((x) => x.mes === mesNutri).map((x) => [x.nutriente, x]));
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
      <hr class="separador">
      <span class="grupo-titulo">Objetivos diarios de nutrición</span>
      <p class="privado">🔒 Privados: solo tú los ves.</p>
      ${NUTRIENTES.map(([k, nom, u]) => {
        const x = nutri[k];
        const tipo = x?.tipo || "";
        return `
        <div class="nutri" data-nutriente="${k}">
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
      }).join("")}
      <button type="button" id="mm-guardar" class="boton-principal">Guardar metas de ${nombreMes(mes)}</button>`;

    const pintarValores = () => cont.querySelectorAll(".nutri").forEach((f) => {
      const t = f.querySelector("select").value;
      f.querySelector(".valores").hidden = !t;
      f.querySelector(".v-min").hidden = !(t === "minimo" || t === "rango");
      f.querySelector(".v-max").hidden = !(t === "maximo" || t === "rango");
    });
    pintarValores();
    cont.addEventListener("change", (e) => { if (e.target.matches(".nutri select")) pintarValores(); });

    $("mm-menos").onclick = () => { entrenos = Math.max(1, entrenos - 1); $("mm-entrenos").textContent = entrenos; };
    $("mm-mas").onclick = () => { entrenos = Math.min(7, entrenos + 1); $("mm-entrenos").textContent = entrenos; };

    $("mm-guardar").onclick = async (e) => {
      const nutricion = [];
      for (const f of cont.querySelectorAll(".nutri")) {
        const tipo = f.querySelector("select").value;
        if (!tipo) continue;
        const vmin = f.querySelector(".v-min").value, vmax = f.querySelector(".v-max").value;
        const nom = f.querySelector(".nombre-nutri").textContent;
        if ((tipo !== "maximo" && vmin === "") || (tipo !== "minimo" && vmax === "")) return avisar(`Completa el valor de ${nom}.`);
        if (tipo === "rango" && Number(vmin) > Number(vmax)) return avisar(`En ${nom}, el mínimo no puede ser mayor que el máximo.`);
        nutricion.push({ nutriente: f.dataset.nutriente, tipo, valor_min: tipo === "maximo" ? "" : vmin, valor_max: tipo === "minimo" ? "" : vmax });
      }
      const alcohol = $("mm-alcohol").value;
      e.target.disabled = true;
      const r = await db.rpc("guardar_meta_mensual", {
        p_mes: mes, p_entrenos: entrenos,
        p_libres: Number($("mm-libres").value || 0),
        p_alcohol: alcohol === "" ? null : Number(alcohol),
        p_nutricion: nutricion
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

  // ---------- Vista Entrenar
  let entrenarDe = "yo";
  async function vistaEntrenar() {
    const y = yo(), p = pareja();
    const meta = y.meta_mes?.entrenos_semana || 0;
    const dias = (y.dias_entrenados || []).length;
    const pct = meta ? Math.min(100, Math.round((dias / meta) * 100)) : 0;
    $("vista").innerHTML = `
      <h2 class="titulo">Entrenar</h2>
      <p class="sub">Semana del ${fechaCorta(y.semana_actual)}</p>
      <section class="tarjeta">
        <h3>Esta semana</h3>
        <div class="cifra">${Math.min(dias, meta || dias)}<small> de ${meta || "—"} días con entrenamiento</small></div>
        <div class="progreso"><span style="width:${pct}%"></span></div>
        <p>${y.entrenos_semana ?? 0} entrenamiento${y.entrenos_semana === 1 ? "" : "s"} registrado${y.entrenos_semana === 1 ? "" : "s"}${dias > meta && meta ? ` · ${dias - meta} día${dias - meta === 1 ? "" : "s"} adicional${dias - meta === 1 ? "" : "es"}` : ""}. El conteo oficial de puntos llega en la fase 3.</p>
        <button type="button" class="boton-principal" data-accion="registrar" style="margin-top:16px">Registrar entrenamiento</button>
      </section>
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
    cargarRutinas();
  }

  async function cargarListaEntrenos() {
    const quien = entrenarDe === "yo" ? yo() : pareja();
    const cont = $("lista-entrenos");
    if (!quien) { cont.innerHTML = ""; return; }
    const { data, error } = await db.from("entrenos")
      .select("*, evidencias(ruta, miniatura), rutinas_youtube(video_id, titulo)")
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
      aviso.textContent = min && min < 20 ? "Con menos de 20 minutos se guarda, pero no cuenta para tu meta semanal." : "";
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
      .select("*, evidencias(ruta), rutinas_youtube(video_id, titulo), entrenos_privado(kcal_est)").eq("id", id).single();
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
      ${e.duracion_min < 20 ? `<span class="etiqueta">Menos de 20 min: no cuenta para la meta</span>` : ""}
      <div class="galeria">${e.evidencias.map((x) => urls[x.ruta] ? `<img src="${urls[x.ruta]}" alt="Evidencia">` : "").join("")}</div>
      ${e.animo ? `<section class="tarjeta"><h3>${ANIMO[e.animo].emoji} ${ANIMO[e.animo].nombre}</h3>${e.animo_nota ? `<p>${esc(e.animo_nota)}</p>` : ""}</section>` : ""}
      ${e.rutinas_youtube ? `<section class="tarjeta"><div class="yt"><img src="${miniaturaYoutube(e.rutinas_youtube.video_id)}" alt=""><div><strong>${esc(e.rutinas_youtube.titulo || "Rutina de YouTube")}</strong>
        <div class="acciones-fila"><a href="${enlaceYoutube(e.rutinas_youtube.video_id)}" target="_blank" rel="noopener">▶ Abrir</a></div></div></div></section>` : ""}
      ${e.notas ? `<section class="tarjeta"><h3>Notas</h3><p>${esc(e.notas)}</p></section>` : ""}
      ${esMio && kcal ? `<div class="kcal">🔒 Aproximadamente ${kcal} kcal quemadas (solo tú lo ves).</div>` : ""}
      ${!esMio && e.juntos === "pendiente" ? `<div class="acciones-juntos"><button type="button" data-entreno-juntos="si" data-id="${e.id}">Confirmar que fue juntos</button>
        <button type="button" class="secundario" style="margin:0" data-entreno-juntos="no" data-id="${e.id}">No fue juntos</button></div>` : ""}
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
