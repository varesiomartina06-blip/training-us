// training.us — app.js (fase 0: inicio de sesión con código por correo)
(() => {
  const cfg = window.TRAINING_US_CONFIG;
  const $ = (id) => document.getElementById(id);

  if (!cfg || cfg.supabaseUrl.startsWith("PEGA_AQUI")) {
    mostrarMensaje("Falta configurar config.js con la Project URL y la llave de Supabase.");
    return;
  }

  const db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  let correoActual = "";

  // ---------- Pantallas ----------
  function mostrar(id) {
    ["paso-correo", "paso-codigo", "inicio"].forEach((s) => ($(s).hidden = s !== id));
  }

  function mostrarMensaje(texto, tipo = "error") {
    const m = $("mensaje");
    m.textContent = texto;
    m.className = "mensaje" + (tipo === "ok" ? " ok" : "");
    m.hidden = !texto;
  }

  function pintarInicio(usuario) {
    const correo = (usuario.email || "").toLowerCase();
    const perfil = cfg.usuarios[correo] || { nombre: correo.split("@")[0], tema: "" };
    document.body.className = perfil.tema ? "tema-" + perfil.tema : "";
    $("nombre").textContent = perfil.nombre;
    const instalada = window.navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    $("estado-instalacion").textContent = instalada
      ? "Abierta desde la pantalla de inicio"
      : "Abierta en el navegador. Para instalarla en iPhone: Compartir → Agregar a pantalla de inicio";
    mostrar("inicio");
  }

  // ---------- Paso 1: pedir código ----------
  $("form-correo").addEventListener("submit", async (e) => {
    e.preventDefault();
    const correo = $("correo").value.trim().toLowerCase();
    if (!correo.includes("@")) return mostrarMensaje("Escribe un correo válido.");
    const boton = e.submitter; boton.disabled = true; mostrarMensaje("");

    const { error } = await db.auth.signInWithOtp({
      email: correo,
      options: { shouldCreateUser: false } // nunca crea cuentas nuevas
    });
    boton.disabled = false;

    if (error) {
      const texto = (error.message || "").toLowerCase();
      if (texto.includes("signup") || texto.includes("not allowed") || error.status === 422) {
        return mostrarMensaje("Este correo no tiene acceso a training.us.");
      }
      if (error.status === 429 || texto.includes("rate")) {
        return mostrarMensaje("Se pidieron demasiados códigos. Espera unos minutos y vuelve a intentarlo.");
      }
      return mostrarMensaje("No se pudo enviar el código: " + error.message);
    }
    correoActual = correo;
    $("correo-enviado").textContent = correo;
    $("codigo").value = "";
    mostrar("paso-codigo");
    mostrarMensaje("Código enviado. Revisa también la carpeta de spam.", "ok");
    $("codigo").focus();
  });

  // ---------- Paso 2: verificar código ----------
  $("form-codigo").addEventListener("submit", async (e) => {
    e.preventDefault();
    const codigo = $("codigo").value.replace(/\D/g, "");
    if (codigo.length < 6) return mostrarMensaje("El código tiene al menos 6 números.");
    const boton = e.submitter; boton.disabled = true; mostrarMensaje("");

    const { data, error } = await db.auth.verifyOtp({ email: correoActual, token: codigo, type: "email" });
    boton.disabled = false;
    if (error) return mostrarMensaje("El código no es válido o ya caducó. Pide uno nuevo.");
    mostrarMensaje("");
    pintarInicio(data.user);
  });

  $("otro-correo").addEventListener("click", () => { mostrarMensaje(""); mostrar("paso-correo"); });

  $("cerrar-sesion").addEventListener("click", async () => {
    await db.auth.signOut();
    document.body.className = "";
    $("correo").value = "";
    mostrar("paso-correo");
  });

  // ---------- Arranque ----------
  db.auth.getSession().then(({ data }) => {
    if (data.session) pintarInicio(data.session.user);
    else mostrar("paso-correo");
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
})();
