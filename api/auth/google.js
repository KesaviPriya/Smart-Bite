// Google Authentication API - Verify Google token and create/login user
import { OAuth2Client } from 'google-auth-library';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { connectToDatabase } from '../lib/mongodb.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const JWT_SECRET = process.env.JWT_SECRET;

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    console.log(`[Google Auth API] Stage: Request received. Method: ${req.method}`);

    // Support GET requests to retrieve Client ID dynamically (fallback for frontend build env issue)
    if (req.method === 'GET') {
        console.log(`[Google Auth API] Stage: Client ID requested. Configured ID: ${GOOGLE_CLIENT_ID ? 'YES' : 'NO'}`);
        return res.status(200).json({ clientId: GOOGLE_CLIENT_ID || '' });
    }

    if (req.method !== 'POST') {
        console.warn(`[Google Auth API] Warning: Method ${req.method} not allowed`);
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { credential } = req.body || {};
        console.log(`[Google Auth API] Stage: Credential received. Credential presence: ${credential ? 'YES' : 'NO'}`);

        if (!credential) {
            console.error('[Google Auth API] Error: Google credential token is missing from request body');
            return res.status(400).json({ error: 'Google credential is required' });
        }

        if (!GOOGLE_CLIENT_ID) {
            console.error('[Google Auth API] Error: GOOGLE_CLIENT_ID env variable is not configured');
            return res.status(500).json({ error: 'Google Sign-In not configured on server' });
        }

        if (!JWT_SECRET) {
            console.error('[Google Auth API] Error: JWT_SECRET env variable is not configured');
            return res.status(500).json({ error: 'Server configuration error (JWT_SECRET missing)' });
        }

        // Verify the Google token
        const client = new OAuth2Client(GOOGLE_CLIENT_ID);
        
        let ticket;
        try {
            console.log('[Google Auth API] Stage: Starting Google token verification...');
            ticket = await client.verifyIdToken({
                idToken: credential,
                audience: GOOGLE_CLIENT_ID
            });
            console.log('[Google Auth API] Stage: Google token verified successfully');
        } catch (verifyError) {
            console.error('[Google Auth API] Error: Token verification failed:', verifyError.message);
            return res.status(401).json({ 
                error: 'Invalid Google token', 
                details: verifyError.message 
            });
        }

        const payload = ticket.getPayload();
        if (!payload) {
            console.error('[Google Auth API] Error: Ticket payload is empty or invalid');
            return res.status(401).json({ error: 'Invalid Google token payload' });
        }

        const googleId = payload.sub;
        const email = payload.email;
        const name = payload.name || (email ? email.split('@')[0] : 'google_user');
        const picture = payload.picture;

        console.log('[Google Auth API] Stage: Google user payload parsed:', { googleId, email, name });

        // Connect to database
        console.log('[Google Auth API] Stage: Connecting to database...');
        let db;
        try {
            const connection = await connectToDatabase();
            db = connection.db;
            console.log('[Google Auth API] Stage: Database connection established');
        } catch (dbError) {
            console.error('[Google Auth API] Error: Failed to connect to MongoDB:', dbError.message);
            return res.status(500).json({ 
                error: 'Database connection failed', 
                details: dbError.message 
            });
        }

        const usersCollection = db.collection('users');

        // Find existing user by Google ID or email
        console.log('[Google Auth API] Stage: Searching for existing user in DB...');
        const emailQuery = email ? email.toLowerCase() : '__no_email_provided__';
        let user = await usersCollection.findOne({
            $or: [
                { googleId },
                { email: emailQuery }
            ]
        });

        if (user) {
            console.log(`[Google Auth API] Stage: User found in database. ID: ${user._id}`);
            // Update existing user with Google info if not already set
            const updates = {};
            if (!user.googleId) {
                updates.googleId = googleId;
            }
            if (picture && !user.picture) {
                updates.picture = picture;
            }

            if (Object.keys(updates).length > 0) {
                console.log('[Google Auth API] Stage: Updating existing user with Google attributes...', updates);
                await usersCollection.updateOne(
                    { _id: user._id },
                    { 
                        $set: { 
                            ...updates,
                            updatedAt: new Date()
                        }
                    }
                );
                // Sync local user object
                user = { ...user, ...updates };
                console.log('[Google Auth API] Stage: User attributes updated in database');
            }
            console.log('[Google Auth API] Stage: Existing user logged in:', user.username || user.email);
        } else {
            console.log('[Google Auth API] Stage: User not found. Preparing to create a new user...');
            
            // Clean and generate a base username
            let baseUsername = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
            if (baseUsername.length < 3) {
                baseUsername = 'user_' + baseUsername;
            }

            // Resolve conflicts if username is already taken
            let username = baseUsername;
            let existingUserCount = 0;
            while (await usersCollection.findOne({ username })) {
                existingUserCount++;
                username = `${baseUsername}_${Math.floor(1000 + Math.random() * 9000)}`;
                console.log(`[Google Auth API] Warning: Username collision. Trying alternate username: ${username}`);
            }

            // Create new user
            const newUser = {
                username,
                email: emailQuery,
                googleId,
                picture,
                // Random secure password for Google users
                password: await bcrypt.hash(Math.random().toString(36) + Math.random().toString(36), 10),
                createdAt: new Date(),
                updatedAt: new Date()
            };

            console.log('[Google Auth API] Stage: Inserting new user record...', { username, email: emailQuery });
            const result = await usersCollection.insertOne(newUser);
            user = { _id: result.insertedId, ...newUser };
            console.log('[Google Auth API] Stage: New Google user created successfully. ID:', user._id);
        }

        // Generate JWT
        console.log('[Google Auth API] Stage: Generating JWT token...');
        const token = jwt.sign(
            { 
                userId: user._id.toString(), 
                username: user.username || name,
                email: user.email
            },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        console.log('[Google Auth API] Stage: JWT generated successfully');

        console.log('[Google Auth API] Stage: Authentication completed. Returning success response');
        return res.status(200).json({
            success: true,
            token,
            user: {
                id: user._id.toString(),
                username: user.username || name,
                email: user.email === '__no_email_provided__' ? '' : user.email,
                picture: user.picture || picture
            }
        });

    } catch (error) {
        console.error('[Google Auth API] Stage: Critical error encountered during authentication:', error);
        console.error('[Google Auth API] Stack trace:', error.stack);
        return res.status(500).json({ 
            error: 'Authentication failed', 
            details: error.message,
            stack: error.stack
        });
    }
}
