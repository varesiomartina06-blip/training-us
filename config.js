// training.us — configuración pública.
// Estos dos valores son seguros en un repositorio público: la llave "publishable/anon"
// solo permite lo que las reglas de seguridad (RLS) de la base de datos autorizan.
window.TRAINING_US_CONFIG = {
  supabaseUrl: "PEGA_AQUI_TU_PROJECT_URL",          // ej.: https://abcdefgh.supabase.co
  supabaseKey: "PEGA_AQUI_TU_PUBLISHABLE_KEY",      // empieza por sb_publishable_ o eyJ...
  // Correo de cada participante (en minúsculas) → nombre y color en la app
  usuarios: {
    "correo.de.ella@gmail.com": { nombre: "Ella", tema: "rosa" },
    "correo.de.el@gmail.com":   { nombre: "Él",   tema: "azul" }
  }
};
