const express = require("express");
const app = express();
const mongoose = require("mongoose");
const Listing = require("./models/listing.js");
const Order = require("./models/order.js");
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
const DELIVERY_FEE = 80;
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
function renderAuth(res, options = {}) { res.render("listings/auth.ejs", { layout: false, mode: "login", stage: "start", email: "", error: "", ...options }); }
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

app.get("/",(req,res)=> res.render("listings/home.ejs"));
app.get("/cart",(req,res) => res.render("listings/cart.ejs", { deliveryFee: DELIVERY_FEE }));
app.post("/cart/address", requireLogin, async (req,res,next) => {
    try {
        const address = String(req.body.address || "").trim().slice(0, 500);
        if (address.length < 8) return res.status(400).json({ error: "Enter a complete delivery address." });
        res.json({ address });
    } catch (error) { next(error); }
});
app.post("/orders", requireLogin, async (req, res, next) => {
    try {
        const { items, fulfillment, paymentMethod, address } = req.body || {};
        if (!Array.isArray(items) || !items.length || items.length > 50) return res.status(400).json({ error: "Your cart is empty or too large." });
        if (!['delivery', 'pickup'].includes(fulfillment)) return res.status(400).json({ error: "Choose delivery or store pickup." });
        if (fulfillment === "delivery" && !["cod", "online"].includes(paymentMethod)) return res.status(400).json({ error: "Choose a payment method." });
        if (fulfillment === "pickup" && !["pay-at-store", "online"].includes(paymentMethod)) return res.status(400).json({ error: "Choose a payment method." });
        const customerName = String(req.user?.name || (DEV_AUTH_BYPASS ? "Local developer" : "Gavlee customer")).trim().slice(0, 100);
        const customerPhone = "";
        const customerEmail = String(req.user?.email || "").trim().slice(0, 120);
        const deliveryAddress = String(address || "").trim().slice(0, 500);
        if (fulfillment === "delivery" && deliveryAddress.length < 8) return res.status(400).json({ error: "Enter a complete delivery address." });

        let subtotal = 0;
        let gst = 0;
        const orderItems = [];
        for (const item of items) {
            const quantity = Number(item.quantity);
            if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return res.status(400).json({ error: "Check the quantity for each item." });
            const listing = await Listing.findById(item.id);
            if (!listing) return res.status(400).json({ error: "A product in your cart is no longer available." });
            const flavour = String(item.flavour || "").trim().slice(0, 80);
            let unitPrice = Number(listing.price);
            if (flavour) {
                const option = (listing.flavourOptions || []).find(entry => entry.name === flavour);
                if (option) unitPrice = Number(option.price);
                else if ((listing.flavours || []).includes(flavour)) unitPrice = Number(listing.price);
                else if (["LASSI", "ICE CREAMS", "SHRIKHAND", "WHIPPED CREAM", "WHEY"].includes(String(listing.title).trim().toUpperCase()) && ["Mango", "Strawberry", "Sweet Kesar", "Masala"].includes(flavour)) unitPrice = Number(listing.price);
                else return res.status(400).json({ error: "A selected product option is no longer available." });
            }
            if (!Number.isFinite(unitPrice) || unitPrice < 0) return res.status(400).json({ error: "A product has an invalid price." });
            subtotal += unitPrice * quantity;
            gst += Math.round(unitPrice * quantity * 0.18 * 100) / 100;
            orderItems.push({ listing: listing._id, title: listing.title, image: listing.image, flavour, quantity, unitPrice });
        }
        subtotal = Math.round(subtotal * 100) / 100;
        gst = Math.round(gst * 100) / 100;
        const shipping = fulfillment === "delivery" ? DELIVERY_FEE : 0;
        let reference;
        let order;
        for (let attempt = 0; attempt < 3; attempt++) {
            reference = `REF${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
            try {
                const total = Math.round((subtotal + gst + shipping) * 100) / 100;
                const orderData = { reference, items: orderItems, customer: { name: customerName || "Gavlee customer", phone: customerPhone, email: customerEmail }, fulfillment, address: fulfillment === "delivery" ? deliveryAddress : "", paymentMethod, subtotal, gst, shipping, total, status: paymentMethod === "online" ? "pending" : "placed" };
                if (paymentMethod === "online") {
                    const keyId = process.env.RAZORPAY_KEY_ID;
                    const keySecret = process.env.RAZORPAY_KEY_SECRET;
                    if (!keyId || !keySecret) return res.status(503).json({ error: "Online payment is not ready yet. Add the Razorpay keys to the server environment." });
                    const razorpayResponse = await fetch("https://api.razorpay.com/v1/orders", {
                        method: "POST",
                        headers: { "Authorization": `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ amount: Math.round(total * 100), currency: "INR", receipt: reference, notes: { gavlee_reference: reference } }),
                    });
                    const razorpayOrder = await razorpayResponse.json();
                    if (!razorpayResponse.ok) return res.status(502).json({ error: razorpayOrder.error?.description || "Could not start online payment. Please try again." });
                    orderData.razorpayOrderId = razorpayOrder.id;
                    order = await Order.create(orderData);
                    return res.status(201).json({ online: true, keyId, razorpayOrderId: razorpayOrder.id, reference, total, customer: order.customer });
                }
                order = await Order.create(orderData);
                break;
            } catch (error) { if (error.code !== 11000) throw error; }
        }
        if (!order) return res.status(500).json({ error: "Could not create an order reference. Please try again." });
        res.status(201).json({ reference: order.reference, total: order.total, fulfillment: order.fulfillment });
    } catch (error) { next(error); }
});
app.post("/orders/razorpay/verify", requireLogin, async (req, res, next) => {
    try {
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body || {};
        const secret = process.env.RAZORPAY_KEY_SECRET;
        if (!process.env.RAZORPAY_KEY_ID || !secret || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) return res.status(400).json({ error: "Payment details are incomplete." });
        const order = await Order.findOne({ razorpayOrderId, paymentMethod: "online", status: "pending" });
        if (!order) return res.status(404).json({ error: "The pending order could not be found." });
        const expected = crypto.createHmac("sha256", secret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest();
        const received = Buffer.from(String(razorpaySignature), "hex");
        if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return res.status(400).json({ error: "Payment verification failed." });
        const keyId = process.env.RAZORPAY_KEY_ID;
        const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(razorpayPaymentId)}`, {
            headers: { "Authorization": `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}` },
        });
        const payment = await paymentResponse.json();
        if (!paymentResponse.ok || payment.order_id !== razorpayOrderId || payment.status !== "captured" || payment.amount !== Math.round(order.total * 100) || payment.currency !== "INR") return res.status(400).json({ error: "Payment is not confirmed as captured yet." });
        order.status = "placed";
        order.razorpayPaymentId = razorpayPaymentId;
        await order.save();
        res.json({ reference: order.reference, total: order.total, fulfillment: order.fulfillment });
    } catch (error) { next(error); }
});
app.get("/checkout/online", (req,res) => res.redirect("/cart"));
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

