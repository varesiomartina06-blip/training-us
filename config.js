// training.us — configuración pública.
// Estos dos valores son seguros en un repositorio público: la llave "publishable/anon"
// solo permite lo que las reglas de seguridad (RLS) de la base de datos autorizan.
window.TRAINING_US_CONFIG = {
  supabaseUrl: "https://wosjzxzzryeldkixcjng.supabase.co",          // ej.: https://abcdefgh.supabase.co
  supabaseKey: "sb_publishable_bz1-km6ZnBBPb4s4VEixtw_kQfhtFPt",      // empieza por sb_publishable_ o eyJ...
  // Correo de cada participante (en minúsculas) → nombre y color en la app
  usuarios: {
    "varesiomartina06@gmail.com": { nombre: "Martina", tema: "rosa" },
    "ramosa14.2004@gmail.com":   { nombre: "Andres",   tema: "azul" }
  }
};
