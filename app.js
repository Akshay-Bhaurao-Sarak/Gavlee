const express = require("express");
const app = express();
const mongoose = require("mongoose");
const Listing = require("./models/listing.js");
const path = require("path");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");
const crypto = require("crypto");
const { promisify } = require("util");
const User = require("./models/user.js");
const AuthSession = require("./models/authsession.js");
const nodemailer = require("nodemailer");
const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "gavlee_session";
const SESSION_DAYS = 30;
const pendingEmailVerifications = new Map();
// Local development opens the app directly. Production still requires real sessions.
const DEV_AUTH_BYPASS = process.env.NODE_ENV !== "production";



const MONGO_URL = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/gavlee";

function parseFlavourOptions(options) {
    if (!options) return [];
    const entries = Array.isArray(options) ? options : [options];
    return entries
        .map(option => ({
            name: String(option.name || "").trim(),
            price: Number(option.price),
        }))
        .filter(option => option.name && Number.isFinite(option.price) && option.price >= 0);
}

main()
.then(() => {
    console.log("Connected to Db");
})
.catch((err) => {
    console.log(err);
});

async function main(){
  await mongoose.connect(MONGO_URL);
}

app.set("view engine","ejs");
app.set("views",path.join(__dirname,"views"));
app.use(express.urlencoded({extended:true, limit: "4mb"}));
app.use(express.json({ limit: "3mb" }));
app.use(methodOverride("_method"));
app.engine('ejs',ejsMate);
app.use(express.static("public"));
app.use(express.static(path.join(__dirname, "public")));

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
async function hashPassword(password) { const salt = crypto.randomBytes(16).toString("hex"); const key = await scrypt(password, salt, 64); return `${salt}:${key.toString("hex")}`; }
async function verifyPassword(password, encoded) { const [salt, key] = String(encoded || "").split(":"); if (!salt || !key) return false; const actual = await scrypt(password, salt, 64); const expected = Buffer.from(key, "hex"); return expected.length === actual.length && crypto.timingSafeEqual(actual, expected); }
function cookieOptions(maxAge) { return { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge }; }
function safeUser(user) { return user ? { id: user._id, email: user.email, name: user.name, avatar: user.avatar } : null; }
app.use(async (req, res, next) => {
    if (DEV_AUTH_BYPASS) {
        req.user = { _id: "local-development-user", email: "dev@localhost", name: "Local developer", avatar: "" };
        res.locals.currentUser = safeUser(req.user);
        return next();
    }
    try {
        const token = req.cookies?.[SESSION_COOKIE] || (req.headers.cookie || "").split(";").map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
        if (token) {
            const session = await AuthSession.findOne({ tokenHash: sha256(decodeURIComponent(token)), expiresAt: { $gt: new Date() } }).populate("user");
            if (session?.user) { req.user = session.user; res.locals.currentUser = safeUser(session.user); }
        }
        next();
    } catch (error) { next(error); }
});
function requireLogin(req, res, next) { if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`); next(); }
function renderAuth(res, options = {}) { res.render("auth.ejs", { layout: false, mode: "login", stage: "start", email: "", error: "", ...options }); }
async function startSession(user, res) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    await AuthSession.create({ tokenHash: sha256(token), user: user._id, expiresAt });
    res.cookie(SESSION_COOKIE, token, cookieOptions(SESSION_DAYS * 24 * 60 * 60 * 1000));
}
async function sendVerificationCode(email, code) {
    const login = process.env.BREVO_SMTP_LOGIN;
    const key = process.env.BREVO_SMTP_KEY;
    const from = process.env.BREVO_FROM_EMAIL;
    if (!login || !key || !from) {
        throw new Error("Brevo SMTP settings are incomplete. Set BREVO_SMTP_LOGIN, BREVO_SMTP_KEY, and BREVO_FROM_EMAIL.");
    }
    const transporter = nodemailer.createTransport({
        host: "smtp-relay.brevo.com",
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: login, pass: key },
    });
    await transporter.sendMail({
        from,
        to: email,
        subject: "Your Gavlee verification code",
        text: `Your Gavlee verification code is ${code}. It expires in 10 minutes.`,
    });
}
async function issueVerification(email) {
    const code = String(crypto.randomInt(100000, 1000000));
    await sendVerificationCode(email, code);
    pendingEmailVerifications.set(email, { codeHash: sha256(code), expiresAt: Date.now() + 10 * 60 * 1000 });
}

app.get("/",(req,res)=> res.render("home.ejs"));
app.get("/login", (req,res) => DEV_AUTH_BYPASS ? res.redirect("/listings") : (req.user ? res.redirect("/listings") : renderAuth(res, { mode: "login", error: req.query.error || "" })));
app.post("/login", async (req,res,next) => {
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        const user = await User.findOne({ email });
        if (!user || !(await verifyPassword(req.body.password || "", user.passwordHash))) return renderAuth(res, { error: "Email or password is incorrect." });
        user.lastLoginAt = new Date(); await user.save(); await startSession(user, res);
        const nextPath = typeof req.query.next === "string" && req.query.next.startsWith("/") && !req.query.next.startsWith("//") ? req.query.next : "/listings";
        res.redirect(nextPath);
    } catch (error) { next(error); }
});
app.get("/register", (req,res) => req.user ? res.redirect("/listings") : renderAuth(res, { mode: "register" }));
app.post("/register", async (req,res,next) => {
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        if (!/^\S+@\S+\.\S+$/.test(email)) return renderAuth(res, { mode: "register", error: "Enter a valid email address." });
        if (await User.exists({ email })) return renderAuth(res, { mode: "register", error: "An account with that email already exists. Sign in instead." });
        await issueVerification(email);
        res.redirect(`/register/verify?email=${encodeURIComponent(email)}`);
    } catch (error) {
        console.error("OTP email delivery failed; check the Brevo SMTP login, key, and sender configuration.");
        renderAuth(res, { mode: "register", error: "We couldn't send the verification email. Please check the Brevo SMTP settings and try again." });
    }
});
app.get("/register/verify", (req,res) => renderAuth(res, { stage: "verify", email: String(req.query.email || "").toLowerCase(), error: req.query.error || "" }));
app.post("/register/resend", async (req,res,next) => { try { const email = String(req.body.email || "").trim().toLowerCase(); await issueVerification(email); res.redirect(`/register/verify?email=${encodeURIComponent(email)}`); } catch (error) { console.error("OTP resend failed; check the Brevo SMTP login, key, and sender configuration."); renderAuth(res, { stage: "verify", email: String(req.body.email || "").trim().toLowerCase(), error: "We couldn't send another code. Please check the Brevo SMTP settings and try again." }); } });
app.post("/register/verify", async (req,res,next) => {
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        const record = pendingEmailVerifications.get(email);
        if (!record || record.expiresAt <= Date.now() || !/^[0-9]{6}$/.test(req.body.otp || "") || record.codeHash !== sha256(req.body.otp)) return res.redirect(`/register/verify?email=${encodeURIComponent(email)}&error=${encodeURIComponent("That code is invalid or expired. Request a new one and try again.")}`);
        record.codeHash = "VERIFIED";
        res.redirect(`/register/finish?email=${encodeURIComponent(email)}`);
    } catch (error) { next(error); }
});
app.get("/register/finish", async (req,res) => {
    const email = String(req.query.email || "").trim().toLowerCase();
    const verified = pendingEmailVerifications.get(email)?.codeHash === "VERIFIED" && pendingEmailVerifications.get(email).expiresAt > Date.now();
    if (!email || !verified) return res.redirect(`/register/verify?email=${encodeURIComponent(email)}`);
    renderAuth(res, { stage: "finish", email, error: req.query.error || "" });
});
app.post("/register/complete", async (req,res,next) => {
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        const verification = pendingEmailVerifications.get(email);
        const verified = verification?.codeHash === "VERIFIED" && verification.expiresAt > Date.now();
        if (!email || !verified) return res.redirect(`/register/verify?email=${encodeURIComponent(email)}`);
        if ((req.body.password || "").length < 8 || req.body.password !== req.body.confirmPassword) return renderAuth(res, { stage: "finish", email, error: "Use a password of at least 8 characters and make sure both entries match." });
        const passwordHash = await hashPassword(req.body.password);
        const avatar = typeof req.body.avatarData === "string" && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(req.body.avatarData) && req.body.avatarData.length <= 2800000 ? req.body.avatarData : "";
        const user = await User.create({ email, passwordHash, name: String(req.body.name || "").trim().slice(0, 80), avatar, emailVerified: true, lastLoginAt: new Date() });
        pendingEmailVerifications.delete(email);
        await startSession(user, res);
        res.redirect("/listings");
    } catch (error) { if (error.code === 11000) return renderAuth(res, { mode: "register", error: "An account with that email already exists. Sign in instead." }); next(error); }
});
app.post("/logout", async (req,res,next) => { try { const token = (req.headers.cookie || "").split(";").map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1); if (token) await AuthSession.deleteOne({ tokenHash: sha256(decodeURIComponent(token)) }); res.clearCookie(SESSION_COOKIE, cookieOptions(0)); res.redirect("/login"); } catch (error) { next(error); } });

//index route
app.get("/listings",async (req,res) => {
   if (!DEV_AUTH_BYPASS && !req.user) return res.redirect("/login");
   const allListings = await Listing.find({});
   res.render("./listings/index.ejs",{ allListings });
});

//new route
app.get("/listings/new",requireLogin,(req, res) => {
 res.render("listings/new.ejs");
});

//show route
app.get("/listings/:id",requireLogin,async (req,res) =>{
 let {id} = req.params;
 const listing = await Listing.findById(id);
 res.render("listings/show.ejs",{ listing });
});

//creat route
app.post("/listings" , requireLogin, async (req,res) => {
    const listingData = { ...req.body.listing };
    listingData.hasFlavours = listingData.hasFlavours === "true";
    if (listingData.image && !/^https?:\/\//i.test(listingData.image)) {
        listingData.image = listingData.image.replace(/^public\//, "");
        if (!listingData.image.startsWith("/")) listingData.image = `/${listingData.image}`;
    }
    listingData.flavourOptions = listingData.hasFlavours ? parseFlavourOptions(listingData.flavourOptions) : [];
    listingData.flavours = listingData.flavourOptions.map(option => option.name);
    if (listingData.flavourOptions.length) listingData.price = String(listingData.flavourOptions[0].price);
    const newListing = new Listing(listingData);
    await newListing.save();
    res.redirect("/listings");
});

//Edit route
app.get("/listings/:id/edit", requireLogin, async (req,res) => {
 let {id} = req.params;
 const listing = await Listing.findById(id);
 res.render("listings/edit.ejs",{ listing });  
});

//Update route
app.put("/listings/:id", requireLogin, async(req,res)=>{
    let{id} = req.params;
    const listingData = { ...req.body.listing };
    listingData.hasFlavours = listingData.hasFlavours === "true";
    if (listingData.image && !/^https?:\/\//i.test(listingData.image)) {
        listingData.image = listingData.image.replace(/^public\//, "");
        if (!listingData.image.startsWith("/")) listingData.image = `/${listingData.image}`;
    }
    listingData.flavourOptions = listingData.hasFlavours ? parseFlavourOptions(listingData.flavourOptions) : [];
    listingData.flavours = listingData.flavourOptions.map(option => option.name);
    if (listingData.flavourOptions.length) listingData.price = String(listingData.flavourOptions[0].price);
    await Listing.findByIdAndUpdate(id, listingData);
    res.redirect("/listings");
});

//Delete route
app.delete("/listings/:id", requireLogin, async (req,res) => {
    let{ id } = req.params;
    let deletedListing = await Listing.findByIdAndDelete(id);
    console.log(deletedListing);
    res.redirect("/listings");
});



const PORT = process.env.PORT || 8080;
app.listen(PORT,()=>{
    console.log(`Server is listening to port ${PORT}`); 
});

