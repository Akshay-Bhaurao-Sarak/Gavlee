const express = require("express");
const app = express();
const mongoose = require("mongoose");
const Listing = require("./models/listing.js");
const Order = require("./models/order.js");
const path = require("path");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");
const crypto = require("crypto");
const DELIVERY_FEE = 80;
const raizorpay ="razorpay"



let mongoConnection;

async function connectToDatabase() {
    const uri = process.env.MONGODB_URI?.trim();
    const hosted = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
    if (!uri && hosted) {
        throw new Error("Set MONGODB_URI to the MongoDB Atlas connection string.");
    }

    mongoConnection ??= mongoose.connect(uri || "mongodb://127.0.0.1:27017/gavlee", {
        serverSelectionTimeoutMS: 5000,
    }).catch(error => {
        mongoConnection = undefined;
        throw error;
    });
    await mongoConnection;
}

async function requireDatabase(req, res, next) {
    try {
        await connectToDatabase();
    } catch (error) {
        console.error("MongoDB connection failed:", error.message);
        return res.status(503).send("The database is temporarily unavailable.");
    }
    next();
}

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

app.set("view engine","ejs");
app.set("views",path.join(__dirname,"views"));
app.locals.enableSpeedInsights = process.env.VERCEL === "1";
app.use(express.urlencoded({extended:true, limit: "4mb"}));
// Keep the raw body available for Razorpay's webhook signature verification.
app.post("/webhooks/razorpay", express.raw({ type: "application/json", limit: "1mb" }), async (req, res, next) => {
    try {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        const signature = req.get("x-razorpay-signature");
        if (!webhookSecret || !signature || !Buffer.isBuffer(req.body)) return res.sendStatus(400);
        const expected = crypto.createHmac("sha256", webhookSecret).update(req.body).digest();
        let received;
        try { received = Buffer.from(signature, "hex"); } catch { return res.sendStatus(400); }
        if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return res.sendStatus(400);

        const event = JSON.parse(req.body.toString("utf8"));
        if (event.event === "payment.captured") {
            const payment = event.payload?.payment?.entity;
            if (payment?.order_id && payment?.id) {
                await connectToDatabase();
                const order = await Order.findOne({ razorpayOrderId: payment.order_id, paymentMethod: "online" });
                if (order && payment.amount === Math.round(order.total * 100) && payment.currency === "INR") {
                    if (order.status === "pending") {
                        const updated = await Order.findOneAndUpdate(
                            { _id: order._id, status: "pending", razorpayPaymentId: null },
                            { $set: { status: "placed", razorpayPaymentId: payment.id } }
                        );
                        if (!updated) {
                            const current = await Order.findById(order._id);
                            if (current?.status !== "placed" || current.razorpayPaymentId !== payment.id) return res.sendStatus(409);
                        }
                    } else if (order.razorpayPaymentId && order.razorpayPaymentId !== payment.id) {
                        return res.sendStatus(409);
                    }
                }
            }
        }
        res.sendStatus(200);
    } catch (error) { next(error); }
});
app.use(express.json({ limit: "3mb" }));
app.use(methodOverride("_method"));
app.engine('ejs',ejsMate);
app.use(express.static(path.join(__dirname, "public")));
app.use(["/listings", "/orders"], requireDatabase);

app.get("/",(req,res)=> res.render("listings/home.ejs"));
app.get("/cart",(req,res) => res.render("listings/cart.ejs", { deliveryFee: DELIVERY_FEE }));
app.post("/cart/address", async (req,res,next) => {
    try {
        const address = String(req.body.address || "").trim().slice(0, 500);
        if (address.length < 8) return res.status(400).json({ error: "Enter a complete delivery address." });
        res.json({ address });
    } catch (error) { next(error); }
});
app.post("/orders", async (req, res, next) => {
    try {
        const { items, fulfillment, paymentMethod, address } = req.body || {};
        if (!Array.isArray(items) || !items.length || items.length > 50) return res.status(400).json({ error: "Your cart is empty or too large." });
        if (!['delivery', 'pickup'].includes(fulfillment)) return res.status(400).json({ error: "Choose delivery or store pickup." });
        if (fulfillment === "delivery" && !["cod", "online"].includes(paymentMethod)) return res.status(400).json({ error: "Choose a payment method." });
        if (fulfillment === "pickup" && !["pay-at-store", "online"].includes(paymentMethod)) return res.status(400).json({ error: "Choose a payment method." });
        const customerName = "Gavlee customer";
        const customerPhone = "";
        const customerEmail = "";
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
app.post("/orders/razorpay/verify", async (req, res, next) => {
    try {
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body || {};
        const secret = process.env.RAZORPAY_KEY_SECRET;
        if (!process.env.RAZORPAY_KEY_ID || !secret || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) return res.status(400).json({ error: "Payment details are incomplete." });
        const order = await Order.findOne({ razorpayOrderId, paymentMethod: "online" });
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
        if (order.status === "placed") {
            if (order.razorpayPaymentId !== razorpayPaymentId) return res.status(409).json({ error: "This order was confirmed with a different payment." });
        } else {
            const updated = await Order.findOneAndUpdate(
                { _id: order._id, status: "pending", razorpayPaymentId: null },
                { $set: { status: "placed", razorpayPaymentId } },
                { new: true }
            );
            if (!updated) {
                const current = await Order.findById(order._id);
                if (current?.status !== "placed" || current.razorpayPaymentId !== razorpayPaymentId) return res.status(409).json({ error: "Payment confirmation is already being processed." });
            }
        }
        res.json({ reference: order.reference, total: order.total, fulfillment: order.fulfillment });
    } catch (error) { next(error); }
});
app.get("/checkout/online", (req,res) => res.redirect("/cart"));

//index route
app.get("/listings",async (req,res) => {
   const allListings = await Listing.find({});
   res.render("./listings/index.ejs",{ allListings });
});

//new route
app.get("/listings/new",(req, res) => {
 res.render("listings/new.ejs");
});

//show route
app.get("/listings/:id",async (req,res) =>{
 let {id} = req.params;
 const listing = await Listing.findById(id);
 res.render("listings/show.ejs",{ listing });
});

//creat route
app.post("/listings" , async (req,res) => {
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
app.get("/listings/:id/edit", async (req,res) => {
 let {id} = req.params;
 const listing = await Listing.findById(id);
 res.render("listings/edit.ejs",{ listing });  
});

//Update route
app.put("/listings/:id", async(req,res)=>{
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
app.delete("/listings/:id", async (req,res) => {
    let{ id } = req.params;
    let deletedListing = await Listing.findByIdAndDelete(id);
    console.log(deletedListing);
    res.redirect("/listings");
});



if (require.main === module) {
    const PORT = process.env.PORT || 8080;
    app.listen(PORT, () => {
        console.log(`Server is listening to port ${PORT}`);
    });
}

module.exports = app;

