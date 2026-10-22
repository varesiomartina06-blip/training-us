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
    document.body.className = "";
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
    document.body.className = perfil.tema ? "tema-" + perfil.tema : "";
    if (!perfil.completado) return vistaPerfil(true);
    $("pestanas").hidden = false;
    irA(vistaActual);
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
    if (v === "inicio") vistaInicio();
    else if (v === "metas") vistaMetas();
    else vistaPerfil(false);
  }

  // ================================================================ INICIO
  function tarjetaParticipante(p, esYo) {
    const tema = p.tema || "";
    const nombre = esc(p.nombre || "Sin nombre todavía");
    const meta = p.meta_mes;
    const sem = p.meta_semana;
    const dias = sem ? DIAS.map((d, i) =>
      `<span class="dia ${sem.dias_previstos.includes(i + 1) ? "on" : ""}" aria-label="${d}">${d}</span>`).join("") : "";
    const zonaTxt = p.zona.replace(/_/g, " ").split("/").pop();
    return `
      <section class="tarjeta ${tema}">
        <h3 class="nombre-${tema}">${nombre}${esYo ? " (tú)" : ""}</h3>
        <p>${meta ? `Meta: ${meta.entrenos_semana} entrenamientos por semana` : "Todavía sin metas del mes"}</p>
        ${sem ? `<div class="dias">${dias}</div>` : `<p>Sin días previstos esta semana</p>`}
        <p>Hora de ${esc(zonaTxt)}</p>
        ${!p.completado ? `<p>Aún no ha completado su perfil.</p>` : ""}
        ${p.zona_pendiente ? `<div class="aviso">Cambio a hora de ${esc(p.zona_pendiente.zona.split("/").pop().replace(/_/g, " "))} desde el ${fechaCorta(p.zona_pendiente.desde)}.</div>` : ""}
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
      ${tarjetaJuntos()}`;
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
    $("pestanas").hidden = esPrimeraVez;
    const temaDefecto = perfil.tema || cfg.usuarios?.[perfil.email]?.tema || "rosa";
    const v = (x) => esc(x ?? "");
    $("vista").innerHTML = `
      <h2 class="titulo">${esPrimeraVez ? "Bienvenida a training.us" : "Tu perfil"}</h2>
      <p class="sub">${esPrimeraVez ? "Antes de empezar, completa tu perfil. Podrás cambiarlo cuando quieras." : "Tu pareja puede ver esta información, salvo el peso."}</p>
      <form id="form-perfil" class="tarjeta" novalidate>
        <div class="campo"><label for="pf-nombre">Nombre o apodo</label>
          <input id="pf-nombre" maxlength="40" required value="${v(perfil.nombre)}"></div>
        <div class="fila campo">
          <div><label for="pf-nac">Fecha de nacimiento</label><input id="pf-nac" type="date" required value="${v(perfil.fecha_nacimiento)}"></div>
          <div><label for="pf-sexo">Sexo</label>
            <select id="pf-sexo" required>
              <option value="">Elegir</option>
              <option value="femenino" ${perfil.sexo === "femenino" ? "selected" : ""}>Femenino</option>
              <option value="masculino" ${perfil.sexo === "masculino" ? "selected" : ""}>Masculino</option>
              <option value="otro" ${perfil.sexo === "otro" ? "selected" : ""}>Otro</option>
            </select></div>
        </div>
        <div class="fila campo">
          <div><label for="pf-estatura">Estatura (cm)</label><input id="pf-estatura" type="number" inputmode="decimal" min="100" max="250" step="0.1" required value="${v(perfil.estatura_cm)}"></div>
          ${esPrimeraVez ? `<div><label for="pf-peso">Peso inicial (kg)</label><input id="pf-peso" type="number" inputmode="decimal" min="30" max="300" step="0.1" required></div>` : "<div></div>"}
        </div>
        ${esPrimeraVez ? `<p class="privado">🔒 El peso es privado: solo tú lo ves.</p>` : ""}
        <div class="campo"><label for="pf-objetivo">Tu objetivo físico</label>
          <textarea id="pf-objetivo" maxlength="300" placeholder="Con tus palabras: qué quieres lograr">${v(perfil.objetivo_fisico)}</textarea></div>
        <span class="grupo-titulo">Tu color en la app</span>
        <div class="opciones">
          <label class="op-rosa"><input type="radio" name="pf-tema" value="rosa" ${temaDefecto === "rosa" ? "checked" : ""}><span>Rosa</span></label>
          <label class="op-azul"><input type="radio" name="pf-tema" value="azul" ${temaDefecto === "azul" ? "checked" : ""}><span>Azul</span></label>
        </div>
        <button type="submit">${esPrimeraVez ? "Guardar y continuar" : "Guardar cambios"}</button>
        ${esPrimeraVez ? "" : `<button type="button" id="btn-salir" class="secundario">Cerrar sesión</button>`}
      </form>`;

    $("btn-salir")?.addEventListener("click", salir);
    $("form-perfil").addEventListener("submit", async (e) => {
      e.preventDefault();
      const datos = {
        nombre: $("pf-nombre").value.trim(),
        fecha_nacimiento: $("pf-nac").value || null,
        sexo: $("pf-sexo").value || null,
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
        <select id="mm-mes">${meses.map((m) => `<option value="${m}">${nombreMes(m)}</option>`).join("")}</select>
        <div id="mm-form"></div>
      </section>

      <section class="tarjeta">
        <h3>Metas de la semana</h3>
        <p>Días previstos de entrenamiento y horarios de sueño. Se configuran cada domingo para la semana siguiente.</p>
        <label class="grupo-titulo" for="ms-semana" style="margin-top:16px">Semana</label>
        <select id="ms-semana">${semanas.map((s) => `<option value="${s}">Semana del ${fechaCorta(s)} (${fmt(mesMeta(s), { month: "long" })})</option>`).join("")}</select>
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
      <div class="fila campo">
        <div><label for="mm-libres">Comidas libres del mes</label><input id="mm-libres" type="number" inputmode="numeric" min="0" max="31" value="${base?.comidas_libres ?? 0}"></div>
        <div><label for="mm-alcohol">Límite de bebidas por semana</label><input id="mm-alcohol" type="number" inputmode="numeric" min="0" max="50" placeholder="Sin límite" value="${base?.alcohol_bebidas_semana ?? ""}"></div>
      </div>
      <hr class="separador">
      <span class="grupo-titulo">Objetivos diarios de nutrición</span>
      <p class="privado" style="margin:0 0 14px">🔒 Privados: solo tú los ves.</p>
      ${NUTRIENTES.map(([k, nom, u]) => {
        const x = nutri[k];
        const tipo = x?.tipo || "";
        return `
        <div class="nutri" data-nutriente="${k}">
          <span class="nombre-nutri">${nom} (${u})</span>
          <select aria-label="Tipo de objetivo de ${nom}">
            <option value="" ${!tipo ? "selected" : ""}>Sin objetivo</option>
            <option value="minimo" ${tipo === "minimo" ? "selected" : ""}>Mínimo</option>
            <option value="maximo" ${tipo === "maximo" ? "selected" : ""}>Máximo</option>
            <option value="rango" ${tipo === "rango" ? "selected" : ""}>Rango</option>
          </select>
          <div class="valores">
            <input class="v-min" type="number" inputmode="decimal" min="0" placeholder="Mínimo" aria-label="${nom} mínimo" value="${x?.valor_min ?? ""}">
            <input class="v-max" type="number" inputmode="decimal" min="0" placeholder="Máximo" aria-label="${nom} máximo" value="${x?.valor_max ?? ""}">
          </div>
        </div>`;
      }).join("")}
      <button type="button" id="mm-guardar">Guardar metas de ${nombreMes(mes)}</button>`;

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
      <p class="ayuda" id="ms-ayuda-dias" style="margin:6px 0 20px"></p>

      <span class="grupo-titulo">Horarios de sueño</span>
      <p class="ayuda" style="margin:0 0 12px">Al elegir una hora, sugerimos la otra para completar 8 horas. Cada par debe sumar entre 6 y 10 horas.</p>
      ${parSueno("Noches de domingo a jueves", "😴 Dormir", "ms-ds", "⏰ Despertar (lun–vie)", "ms-ws", hhmm(base?.dormir_semana), hhmm(base?.despertar_semana))}
      ${parSueno("Noches de viernes y sábado", "😴 Dormir", "ms-df", "⏰ Despertar (sáb–dom)", "ms-wf", hhmm(base?.dormir_finde), hhmm(base?.despertar_finde))}
      <button type="button" id="ms-guardar">Guardar semana del ${fechaCorta(semana)}</button>`;

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

  function parSueno(titulo, l1, id1, l2, id2, v1, v2) {
    return `
      <div class="par-sueno">
        <span class="grupo-titulo">${titulo}</span>
        <div class="fila">
          <div><label for="${id1}">${l1}</label><input id="${id1}" type="time" value="${v1}"></div>
          <div><label for="${id2}">${l2}</label><input id="${id2}" type="time" value="${v2}"></div>
        </div>
        <p class="duracion" id="${id1}-dur"></p>
      </div>`;
  }

  // ================================================================ ARRANQUE
  db.auth.getSession().then(({ data }) => {
    if (data.session) entrar(data.session.user);
    else mostrarAcceso("correo");
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
