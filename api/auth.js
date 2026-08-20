const {baseUrl, send, readBody, supabaseAuth, handlerError} = require("../lib/server");

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") return send(response, 405, {error:"Method not allowed"});
  try {
    const body = await readBody(request);
    const action = String(body.action || "");
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    let payload;

    if (action === "signup") {
      if (!validEmail(email)) return send(response, 400, {error:"Enter a valid email address", code:"INVALID_EMAIL"});
      if (password.length < 8) return send(response, 400, {error:"Password must be at least 8 characters", code:"WEAK_PASSWORD"});
      payload = await supabaseAuth(`/signup?redirect_to=${encodeURIComponent(`${baseUrl()}/?auth=confirmed`)}`, {
        method:"POST",
        body:{email, password}
      });
      return send(response, 200, {
        user:payload.user || null,
        session:payload.session || (payload.access_token ? payload : null),
        confirmationRequired:!payload.access_token
      });
    }

    if (action === "login") {
      if (!validEmail(email) || !password) return send(response, 400, {error:"Enter your email and password", code:"MISSING_LOGIN"});
      payload = await supabaseAuth("/token?grant_type=password", {method:"POST", body:{email, password}});
      return send(response, 200, {session:payload});
    }

    if (action === "refresh") {
      if (!body.refreshToken) return send(response, 400, {error:"Refresh token required", code:"MISSING_REFRESH"});
      payload = await supabaseAuth("/token?grant_type=refresh_token", {method:"POST", body:{refresh_token:String(body.refreshToken)}});
      return send(response, 200, {session:payload});
    }

    if (action === "logout") {
      if (body.accessToken) await supabaseAuth("/logout", {method:"POST", token:String(body.accessToken)});
      return send(response, 200, {ok:true});
    }

    if (action === "recover") {
      if (!validEmail(email)) return send(response, 400, {error:"Enter a valid email address", code:"INVALID_EMAIL"});
      await supabaseAuth("/recover", {
        method:"POST",
        body:{email, redirect_to:`${baseUrl()}/?auth=recovery`}
      });
      return send(response, 200, {ok:true});
    }

    if (action === "update-password") {
      if (!body.accessToken) return send(response, 401, {error:"Recovery session required", code:"AUTH_REQUIRED"});
      if (password.length < 8) return send(response, 400, {error:"Password must be at least 8 characters", code:"WEAK_PASSWORD"});
      await supabaseAuth("/user", {method:"PUT", token:String(body.accessToken), body:{password}});
      return send(response, 200, {ok:true});
    }

    return send(response, 400, {error:"Unknown authentication action", code:"INVALID_ACTION"});
  } catch (error) {
    return handlerError(response, error);
  }
};
