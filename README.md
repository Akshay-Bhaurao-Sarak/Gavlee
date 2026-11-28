# Gavlee
![Logo for brand](public/readmemd.png)

🥛 **Gavlee is my ambitious brainchild and one of my major projects**, built with passion, creativity, and a vision to bring an idea to life. This repository will evolve with daily updates, improvements, and new ideas as I work towards making that vision a reality. 🚀

## Running the app

The app does not use accounts or sign-in. Product and order data are stored in MongoDB. Set `MONGODB_URI` if your database is not at `mongodb://127.0.0.1:27017/gavlee`, then run `npm run dev` or `npm start`.

## Deploying to Vercel

In Vercel, open the project's **Settings → Environment Variables** and set `MONGODB_URI` for **Production** to the Atlas driver connection string. Include the database that already contains your `listings` collection in the URI path, such as `/gavlee` before the query string. Add the variable to **Preview** as well if you use preview deployments.

In Atlas, make sure the database user has access to that database and the project's IP access list permits connections from your Vercel deployment. Deploy the updated code after saving the environment variable, then open `/listings` on the production URL.
