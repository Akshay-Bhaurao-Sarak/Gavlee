const express = require("express");
const app = express();
const mongoose = require("mongoose");
const Listing = require("./models/listing.js");
const path = require("path");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");



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
app.use(express.urlencoded({extended:true}));
app.use(methodOverride("_method"));
app.engine('ejs',ejsMate);
app.use(express.static("public"));
app.use(express.static(path.join(__dirname, "public")));

app.get("/",(req,res)=>{
    res.send(`<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gavlee</title>
    <link rel="icon" type="image/x-icon" href="/gavlee-favicon-large.ico">
</head>
<body>Hi i am gavlee</body>
</html>`);
});

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



const PORT = process.env.PORT || 8080;
app.listen(PORT,()=>{
    console.log(`Server is listening to port ${PORT}`); 
});

